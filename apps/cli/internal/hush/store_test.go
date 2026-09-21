package hush

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newStore(t *testing.T) Store { t.Helper(); return Store{filepath.Join(t.TempDir(), "config")} }
func TestStoreLifecycle(t *testing.T) {
	s := newStore(t)
	one, err := s.Init("https://vault.example", "Test device", "test.access")
	if err != nil {
		t.Fatal(err)
	}
	two, err := s.Init("https://vault.example", "Test device", "test.access")
	if err != nil || one != two {
		t.Fatal("init replaced device", err)
	}
	c, err := s.Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.ClientSecret != "" || c.VaultID != "" {
		t.Fatal("unexpected credential state")
	}
	for path, mode := range map[string]os.FileMode{s.Dir: 0700, filepath.Join(s.Dir, "credentials.json"): 0600} {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != mode {
			t.Fatal("unsafe mode", err)
		}
	}
	if _, err = s.Init("https://different.example", "Test device", "test.access"); err == nil {
		t.Fatal("init silently replaced existing config")
	}
	if err = s.SaveLogin(c, "synthetic-token", "11111111-1111-4111-8111-111111111111"); err != nil {
		t.Fatal(err)
	}
	if err = s.SaveLogin(c, "stale-token", "11111111-1111-4111-8111-111111111111"); err == nil {
		t.Fatal("stale credentials overwrote current state")
	}
	v := loadFixture(t)
	b, err := os.ReadFile(filepath.Join(s.Dir, "credentials.json"))
	if err != nil {
		t.Fatal(err)
	}
	plainVEK, _ := base64.RawURLEncoding.DecodeString(v.VEK)
	if strings.Contains(string(b), v.VEK) || strings.Contains(string(b), string(plainVEK)) || strings.Contains(string(b), v.Plaintext) {
		t.Fatal("persisted vault plaintext")
	}
	if err = s.Logout(); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Load(); err != errNotSetup {
		t.Fatal("logout retained credentials", err)
	}
	if err = s.Logout(); err != nil {
		t.Fatal("logout not idempotent", err)
	}
}
func TestUnsafeStoreRejected(t *testing.T) {
	for _, kind := range []string{"directory-mode", "file-mode", "symlink-file", "symlink-directory", "hardlink", "fifo"} {
		t.Run(kind, func(t *testing.T) {
			s := newStore(t)
			if _, err := s.Init("https://vault.example", "Test", "test.access"); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(s.Dir, "credentials.json")
			switch kind {
			case "directory-mode":
				os.Chmod(s.Dir, 0755)
			case "file-mode":
				os.Chmod(path, 0644)
			case "symlink-file":
				os.Rename(path, path+".real")
				os.Symlink(path+".real", path)
			case "symlink-directory":
				os.Rename(s.Dir, s.Dir+".real")
				os.Symlink(s.Dir+".real", s.Dir)
			case "hardlink":
				os.Link(path, path+".link")
			case "fifo":
				os.Remove(path)
				makeFIFO(t, path)
			}
			if _, err := s.Load(); err == nil {
				t.Fatal("accepted unsafe storage")
			}
		})
	}
}
func TestOriginValidation(t *testing.T) {
	for _, s := range []string{"http://vault.example", "https://a.example/path", "https://user:password@a.example", "https://a.example?token=secret", "https://a.example#x"} {
		if validateURL(s) == nil {
			t.Fatalf("accepted unsafe URL %s", s)
		}
	}
}
