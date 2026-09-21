package hush

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAppLifecycle(t *testing.T) {
	v := loadFixture(t)
	client, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) { serveFixture(t, w, r, v, 1) })
	store := newStore(t)
	c := client.Credentials
	c.ClientSecret = ""
	c.VaultID = ""
	if err := store.update(func(current *Credentials) error { *current = c; return nil }); err != nil {
		t.Fatal(err)
	}
	secretPath := filepath.Join(t.TempDir(), "input")
	os.WriteFile(secretPath, []byte("synthetic-token\n"), 0600)
	input, err := os.Open(secretPath)
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	var output, diagnostics bytes.Buffer
	calls := 0
	app := &App{In: input, Out: &output, Err: &diagnostics, NewClient: func(c Credentials) *Client {
		fresh := NewClient(c)
		fresh.HTTP.Transport = client.HTTP.Transport
		return fresh
	}, Execute: func(args []string, env map[string]string) error {
		calls++
		if strings.Join(args, "|") != "tool|literal ; argument" || env["TEST_TOKEN"] != v.Plaintext {
			t.Error("wrong execution")
		}
		return nil
	}}
	run := func(args ...string) error {
		output.Reset()
		return app.Run(append([]string{"--config-dir", store.Dir}, args...))
	}
	if err = run("login", "--secret-stdin"); err != nil {
		t.Fatal(err)
	}
	stored, err := store.Load()
	if err != nil || stored.VaultID != v.VaultID || stored.ClientSecret != "synthetic-token" {
		t.Fatal("login not stored", err)
	}
	for _, args := range [][]string{{"status", "--json"}, {"secret", "list", "--json"}, {"profile", "list", "--json"}} {
		if err = run(args...); err != nil {
			t.Fatal(err)
		}
		var data any
		if err = json.Unmarshal(output.Bytes(), &data); err != nil {
			t.Fatal("invalid JSON output", err)
		}
		for _, s := range []string{v.Plaintext, v.PrivateKey, v.VEK, "synthetic-token"} {
			if strings.Contains(output.String(), s) {
				t.Fatal("sensitive output")
			}
		}
	}
	if err = run("exec", "agent", "--", "tool", "literal ; argument"); err != nil || calls != 1 {
		t.Fatal("exec failed", err)
	}
	if diagnostics.Len() != 0 {
		t.Fatal("unexpected diagnostics")
	}
	files, err := os.ReadDir(store.Dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		if f.Name() != ".lock" && f.Name() != "credentials.json" {
			t.Fatal("unexpected cache", f.Name())
		}
	}
	if err = run("logout"); err != nil {
		t.Fatal(err)
	}
	if err = run("exec", "agent", "--", "tool"); err == nil || calls != 1 {
		t.Fatal("executed after logout")
	}
}
func TestAppFailuresNeverExecute(t *testing.T) {
	v := loadFixture(t)
	for _, kind := range []string{"revoked", "unavailable", "tampered", "wrong-version", "missing-secret", "bad-args", "bad-profile", "no-login"} {
		t.Run(kind, func(t *testing.T) {
			client, server := testClient(t, func(w http.ResponseWriter, r *http.Request) {
				if kind == "revoked" {
					w.WriteHeader(403)
					return
				}
				if strings.HasSuffix(r.URL.Path, "/secrets") {
					secrets := []Secret{v.secret()}
					switch kind {
					case "tampered":
						secrets[0].Envelope.Ciphertext = "invalid"
					case "wrong-version":
						secrets[0].VEKVersion = 2
					case "missing-secret":
						secrets = []Secret{}
					}
					reply(w, map[string]any{"profile": fixtureProfile(v), "secrets": secrets}, 1)
					return
				}
				serveFixture(t, w, r, v, 1)
			})
			if kind == "unavailable" {
				server.Close()
			}
			store := newStore(t)
			c := client.Credentials
			if kind == "no-login" {
				c.ClientSecret = ""
			}
			if err := store.update(func(current *Credentials) error { *current = c; return nil }); err != nil {
				t.Fatal(err)
			}
			app := &App{Out: io.Discard, Err: io.Discard, NewClient: func(c Credentials) *Client {
				fresh := NewClient(c)
				fresh.HTTP.Transport = client.HTTP.Transport
				return fresh
			}, Execute: func([]string, map[string]string) error { t.Fatal("launched on failure"); return nil }}
			args := []string{"--config-dir", store.Dir, "exec", "agent", "--", "tool"}
			if kind == "bad-args" {
				args = args[:len(args)-2]
			}
			if kind == "bad-profile" {
				args[3] = "missing"
			}
			if err := app.Run(args); err == nil {
				t.Fatal("expected failure")
			}
		})
	}
}
func TestLoginFailurePreservesCredentials(t *testing.T) {
	v := loadFixture(t)
	client, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(403) })
	store := newStore(t)
	before := fixtureCredentials(v, client.Credentials.URL)
	if err := store.update(func(c *Credentials) error { *c = before; return nil }); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "token")
	os.WriteFile(path, []byte("incorrect-token\n"), 0600)
	in, _ := os.Open(path)
	defer in.Close()
	app := &App{In: in, Out: io.Discard, Err: io.Discard, NewClient: func(c Credentials) *Client {
		fresh := NewClient(c)
		fresh.HTTP.Transport = client.HTTP.Transport
		return fresh
	}}
	if err := app.Run([]string{"--config-dir", store.Dir, "login", "--secret-stdin"}); err == nil {
		t.Fatal("accepted failed authentication")
	}
	after, err := store.Load()
	if err != nil || after != before {
		t.Fatal("failed login damaged prior credentials")
	}
}
func TestNoLoginPromptInRoutineCommands(t *testing.T) {
	app := &App{Out: io.Discard, Err: io.Discard, NewClient: func(Credentials) *Client { t.Fatal("unexpected network"); return nil }}
	if err := app.Run([]string{"--config-dir", filepath.Join(t.TempDir(), "missing"), "status"}); !errors.Is(err, errNotSetup) {
		t.Fatal(err)
	}
}
func TestCanceledRequest(t *testing.T) {
	client, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) { t.Error("request should be canceled") })
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := client.Profiles(ctx); err == nil {
		t.Fatal("ignored cancellation")
	}
}

func TestInitExportsOnlyPublicRegistration(t *testing.T) {
	store := newStore(t)
	var out bytes.Buffer
	app := &App{Out: &out, Err: io.Discard, NewClient: func(Credentials) *Client { t.Fatal("init must be local"); return nil }}
	args := []string{"--config-dir", store.Dir, "init", "--url", "https://vault.example/", "--name", "Agent server", "--client-id", "test.access"}
	if err := app.Run(args); err != nil {
		t.Fatal(err)
	}
	var registration map[string]string
	if err := json.Unmarshal(out.Bytes(), &registration); err != nil {
		t.Fatal(err)
	}
	if len(registration) != 4 || !uuidPattern.MatchString(registration["id"]) || registration["public_key"] == "" || registration["access_client_id"] != "test.access" {
		t.Fatal("invalid public enrollment output")
	}
	c, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), c.PrivateKey) {
		t.Fatal("exported private key")
	}
	first := out.String()
	out.Reset()
	if err = app.Run(args); err != nil || out.String() != first {
		t.Fatal("repeated setup changed public identity", err)
	}
}
