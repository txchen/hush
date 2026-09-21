package hush

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

var errNotSetup = errors.New("device is not configured; run hush init")

type Credentials struct {
	Format       int    `json:"format"`
	URL          string `json:"url"`
	Name         string `json:"name"`
	DeviceID     string `json:"device_id"`
	PrivateKey   string `json:"private_key"`
	ClientID     string `json:"access_client_id"`
	ClientSecret string `json:"access_client_secret,omitempty"`
	VaultID      string `json:"vault_id,omitempty"`
}
type Enrollment struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	PublicKey string `json:"public_key"`
	ClientID  string `json:"access_client_id"`
}
type Store struct{ Dir string }

func validateURL(value string) error {
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || (u.Path != "" && u.Path != "/") || u.Opaque != "" {
		return errors.New("service URL must be an HTTPS origin without credentials, path, query, or fragment")
	}
	return nil
}
func (c Credentials) validate() error {
	if c.Format != 1 || !uuidPattern.MatchString(c.DeviceID) || !validName(c.Name) || len(c.ClientID) > 256 || !clientPattern.MatchString(c.ClientID) || (c.VaultID != "" && !uuidPattern.MatchString(c.VaultID)) {
		return errors.New("invalid local credentials")
	}
	if err := validateURL(c.URL); err != nil {
		return err
	}
	b, err := binary(c.PrivateKey, 32, 32)
	clear(b)
	if err != nil {
		return errors.New("invalid local device key")
	}
	if c.ClientSecret != "" && !validToken(c.ClientSecret) {
		return errors.New("invalid Access token secret")
	}
	return nil
}
func validToken(s string) bool {
	if len(s) == 0 || len(s) > 4096 {
		return false
	}
	for _, c := range s {
		if c < 33 || c > 126 {
			return false
		}
	}
	return true
}
func checkMode(info os.FileInfo, dir bool) error {
	st, ok := info.Sys().(*syscall.Stat_t)
	want := os.FileMode(0600)
	if dir {
		want = 0700
	}
	if !ok || st.Uid != uint32(os.Geteuid()) || info.Mode()&os.ModeSymlink != 0 || info.IsDir() != dir || (!dir && (!info.Mode().IsRegular() || st.Nlink != 1)) || info.Mode().Perm() != want {
		return errors.New("unsafe credential storage: require owned directory 0700 and regular files 0600, without symlinks")
	}
	return nil
}
func (s Store) directory(create bool) error {
	if create {
		if err := os.MkdirAll(s.Dir, 0700); err != nil {
			return errors.New("cannot create credential directory")
		}
	}
	info, err := os.Lstat(s.Dir)
	if errors.Is(err, os.ErrNotExist) {
		return errNotSetup
	}
	if err != nil {
		return errors.New("cannot inspect credential directory")
	}
	return checkMode(info, true)
}
func (s Store) Load() (Credentials, error) {
	var c Credentials
	if err := s.directory(false); err != nil {
		return c, err
	}
	f, err := os.OpenFile(filepath.Join(s.Dir, "credentials.json"), os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if errors.Is(err, os.ErrNotExist) {
		return c, errNotSetup
	}
	if err != nil {
		return c, errors.New("cannot read local credentials")
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return c, errors.New("cannot inspect credentials")
	}
	if err = checkMode(info, false); err != nil {
		return c, err
	}
	b, err := io.ReadAll(io.LimitReader(f, 16385))
	defer clear(b)
	if err != nil || len(b) > 16384 || json.Unmarshal(b, &c) != nil {
		return c, errors.New("invalid local credentials")
	}
	return c, c.validate()
}

// Mutations are serialized, and credentials are published with an atomic rename.
func (s Store) update(fn func(*Credentials) error) error {
	if err := s.directory(true); err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(s.Dir, ".lock"), os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0600)
	if err != nil {
		return errors.New("cannot lock credential storage")
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return errors.New("cannot inspect credential lock")
	}
	if err = checkMode(info, false); err != nil {
		return err
	}
	if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return errors.New("credential storage is busy; retry")
	}
	defer syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	c, err := s.Load()
	if err != nil && !errors.Is(err, errNotSetup) {
		return err
	}
	if err = fn(&c); err != nil {
		return err
	}
	if c.Format == 0 {
		err = os.Remove(filepath.Join(s.Dir, "credentials.json"))
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	if err = c.validate(); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return errors.New("cannot encode credentials")
	}
	defer clear(b)
	temp, err := os.CreateTemp(s.Dir, ".credentials-*")
	if err != nil {
		return errors.New("cannot save credentials")
	}
	defer os.Remove(temp.Name())
	defer temp.Close()
	if _, err = temp.Write(b); err != nil {
		return errors.New("cannot save credentials")
	}
	if err = temp.Sync(); err != nil {
		return errors.New("cannot sync credentials")
	}
	if err = temp.Close(); err != nil {
		return errors.New("cannot close credentials")
	}
	if err = os.Rename(temp.Name(), filepath.Join(s.Dir, "credentials.json")); err != nil {
		return errors.New("cannot publish credentials")
	}
	return nil
}
func (s Store) Init(origin, name, clientID string) (Enrollment, error) {
	var result Enrollment
	err := s.update(func(c *Credentials) error {
		if c.Format != 0 {
			if c.URL != origin || c.Name != name || c.ClientID != clientID {
				return errors.New("device already configured; use its existing settings or a different --config-dir")
			}
		} else {
			key, err := ecdh.X25519().GenerateKey(rand.Reader)
			if err != nil {
				return errors.New("device key generation failed")
			}
			id := make([]byte, 16)
			if _, err = rand.Read(id); err != nil {
				return errors.New("device ID generation failed")
			}
			id[6] = (id[6] & 15) | 64
			id[8] = (id[8] & 63) | 128
			*c = Credentials{Format: 1, URL: origin, Name: name, ClientID: clientID, PrivateKey: base64.RawURLEncoding.EncodeToString(key.Bytes()), DeviceID: fmt.Sprintf("%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:])}
		}
		if err := c.validate(); err != nil {
			return err
		}
		raw, _ := binary(c.PrivateKey, 32, 32)
		defer clear(raw)
		key, err := ecdh.X25519().NewPrivateKey(raw)
		if err != nil {
			return errors.New("invalid device key")
		}
		result = Enrollment{c.DeviceID, c.Name, base64.RawURLEncoding.EncodeToString(key.PublicKey().Bytes()), c.ClientID}
		return nil
	})
	return result, err
}
func (s Store) SaveLogin(before Credentials, secret, vaultID string) error {
	return s.update(func(c *Credentials) error {
		if *c != before {
			return errors.New("local credentials changed; retry login")
		}
		c.ClientSecret = secret
		c.VaultID = vaultID
		return nil
	})
}
func (s Store) Logout() error {
	if err := s.directory(false); errors.Is(err, errNotSetup) {
		return nil
	} else if err != nil {
		return err
	}
	return s.update(func(c *Credentials) error { *c = Credentials{}; return nil })
}
func normalizeOrigin(s string) string { return strings.TrimSuffix(s, "/") }
