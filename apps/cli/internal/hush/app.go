package hush

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/term"
)

const help = `Usage: hush [--config-dir DIR] <command>

  init --url https://vault.example --name NAME --client-id ID.access
                         Generate local device key; print public Web enrollment JSON
  login [--secret-stdin]  Verify and store Access token secret (hidden prompt or stdin)
  status [--json]         Check online access and device key decryption
  secret list [--json]    List secret metadata
  profile list [--json]   List profiles and their environment mappings
  exec PROFILE -- COMMAND [ARGS...]
                         Fetch/decrypt online and replace this process with COMMAND
  logout                 Remove local credentials (does not revoke remotely)
  version                Print version

Global flags must precede the command. Routine commands never prompt.
`

type App struct {
	In        *os.File
	Out       io.Writer
	Err       io.Writer
	Version   string
	NewClient func(Credentials) *Client
	Execute   func([]string, map[string]string) error
}

func DefaultApp(version string) *App {
	return &App{os.Stdin, os.Stdout, os.Stderr, version, NewClient, Execute}
}
func flags(name string) *flag.FlagSet {
	f := flag.NewFlagSet(name, flag.ContinueOnError)
	f.SetOutput(io.Discard)
	return f
}
func parse(f *flag.FlagSet, args []string) error {
	if f.Parse(args) != nil || f.NArg() != 0 {
		return errors.New("invalid command arguments; run hush --help")
	}
	return nil
}
func writeJSON(w io.Writer, value any) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(value)
}
func (a *App) Run(args []string) error {
	root := flags("hush")
	dir := root.String("config-dir", "", "credential directory")
	helpFlag := root.Bool("help", false, "help")
	if root.Parse(args) != nil {
		return errors.New("invalid global flags; run hush --help")
	}
	args = root.Args()
	if *helpFlag || len(args) == 0 || (len(args) == 1 && args[0] == "help") {
		_, err := fmt.Fprint(a.Out, help)
		return err
	}
	if len(args) == 1 && args[0] == "version" {
		_, err := fmt.Fprintln(a.Out, "hush", a.Version)
		return err
	}
	if *dir == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			return errors.New("cannot locate config directory; use --config-dir")
		}
		*dir = filepath.Join(base, "hush")
	}
	store := Store{*dir}
	switch args[0] {
	case "init":
		f := flags("init")
		origin := f.String("url", "", "service origin")
		name := f.String("name", "", "device name")
		id := f.String("client-id", "", "Access Client ID")
		if err := parse(f, args[1:]); err != nil {
			return err
		}
		if err := validateURL(*origin); err != nil {
			return err
		}
		if !validName(*name) || !clientPattern.MatchString(*id) || len(*id) > 256 {
			return errors.New("init requires a valid --name and --client-id")
		}
		enrollment, err := store.Init(normalizeOrigin(*origin), *name, *id)
		if err != nil {
			return err
		}
		return writeJSON(a.Out, enrollment)
	case "logout":
		if len(args) != 1 {
			return errors.New("logout takes no arguments")
		}
		if err := store.Logout(); err != nil {
			return err
		}
		_, err := fmt.Fprintln(a.Out, "Local credentials removed. Remote revocation is managed in Web admin.")
		return err
	case "login":
		f := flags("login")
		stdin := f.Bool("secret-stdin", false, "read secret from stdin")
		if err := parse(f, args[1:]); err != nil {
			return err
		}
		before, err := store.Load()
		if err != nil {
			return err
		}
		secret, err := a.readSecret(*stdin)
		if err != nil {
			return err
		}
		defer clear(secret)
		c := before
		c.ClientSecret = string(secret)
		// The network deadline starts after the human finishes entering the token.
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		defer cancel()
		k, vek, _, err := a.NewClient(c).Key(ctx)
		clear(vek)
		if err != nil {
			return err
		}
		if err = store.SaveLogin(before, c.ClientSecret, k.VaultID); err != nil {
			return err
		}
		_, err = fmt.Fprintln(a.Out, "Device verified. Credentials saved.")
		return err
	case "status", "secret", "profile", "exec":
		// Validate syntax before reading credentials or contacting the service.
		jsonOutput := false
		if args[0] == "exec" {
			if len(args) < 4 || args[2] != "--" || args[3] == "" {
				return errors.New("usage: hush exec PROFILE -- COMMAND [ARGS...]")
			}
		} else {
			rest := args[1:]
			if args[0] != "status" {
				if len(rest) == 0 || rest[0] != "list" {
					return errors.New("expected list subcommand")
				}
				rest = rest[1:]
			}
			f := flags(args[0])
			f.BoolVar(&jsonOutput, "json", false, "JSON output")
			if err := parse(f, rest); err != nil {
				return err
			}
		}
		c, err := store.Load()
		if err != nil {
			return err
		}
		client := a.NewClient(c)
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		defer cancel()
		switch args[0] {
		case "status":
			k, vek, _, err := client.Key(ctx)
			clear(vek)
			if err != nil {
				return err
			}
			status := struct {
				Status     string `json:"status"`
				DeviceID   string `json:"device_id"`
				VaultID    string `json:"vault_id"`
				VEKVersion int64  `json:"vek_version"`
			}{"connected", k.DeviceID, k.VaultID, k.VEKVersion}
			if jsonOutput {
				return writeJSON(a.Out, status)
			}
			_, err = fmt.Fprintf(a.Out, "Connected\nDevice: %s\nVault: %s\nKey version: %d\n", k.DeviceID, k.VaultID, k.VEKVersion)
			return err
		case "secret":
			secrets, err := client.Secrets(ctx)
			if err != nil {
				return err
			}
			if jsonOutput {
				return writeJSON(a.Out, struct {
					Secrets []SecretMetadata `json:"secrets"`
				}{secrets})
			}
			for _, s := range secrets {
				if _, err = fmt.Fprintf(a.Out, "%s\t%s\n", s.ID, s.Name); err != nil {
					return err
				}
			}
			return nil
		case "profile":
			profiles, err := client.Profiles(ctx)
			if err != nil {
				return err
			}
			if jsonOutput {
				return writeJSON(a.Out, struct {
					Profiles []Profile `json:"profiles"`
				}{profiles})
			}
			for _, p := range profiles {
				names := make([]string, 0, len(p.Mappings))
				for _, m := range p.Mappings {
					names = append(names, m.EnvName)
				}
				if _, err = fmt.Fprintf(a.Out, "%s\t%s\t%s\n", p.ID, p.Name, strings.Join(names, ",")); err != nil {
					return err
				}
			}
			return nil
		case "exec":
			env, err := client.Environment(ctx, args[1])
			if err != nil {
				return err
			}
			defer clear(env)
			return a.Execute(args[3:], env)
		}
	}
	return errors.New("unknown command; run hush --help")
}
func (a *App) readSecret(fromStdin bool) ([]byte, error) {
	if fromStdin {
		if term.IsTerminal(int(a.In.Fd())) {
			return nil, errors.New("--secret-stdin requires piped input; omit it for a hidden prompt")
		}
		b, err := io.ReadAll(io.LimitReader(a.In, 4099))
		if err != nil || len(b) > 4098 {
			clear(b)
			return nil, errors.New("cannot read Access token secret")
		}
		s := strings.TrimSuffix(strings.TrimSuffix(string(b), "\n"), "\r")
		clear(b)
		if !validToken(s) {
			return nil, errors.New("invalid Access token secret")
		}
		return []byte(s), nil
	}
	if !term.IsTerminal(int(a.In.Fd())) {
		return nil, errors.New("login needs a terminal or --secret-stdin")
	}
	fmt.Fprint(a.Err, "Access Client Secret: ")
	b, err := term.ReadPassword(int(a.In.Fd()))
	fmt.Fprintln(a.Err)
	if err != nil || !validToken(string(b)) {
		clear(b)
		return nil, errors.New("cannot read a valid Access token secret")
	}
	return b, nil
}
