package hush

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const profileID = "44444444-4444-4444-8444-444444444444"

func fixtureProfile(v fixture) Profile {
	return Profile{profileID, "agent", []Mapping{{v.SecretID, "TEST_TOKEN"}}}
}
func fixtureCredentials(v fixture, origin string) Credentials {
	return Credentials{Format: 1, URL: origin, Name: "Test device", DeviceID: v.DeviceID, PrivateKey: v.PrivateKey, ClientID: "test.access", ClientSecret: "synthetic-token", VaultID: v.VaultID}
}
func testClient(t *testing.T, handler http.HandlerFunc) (*Client, *httptest.Server) {
	t.Helper()
	server := httptest.NewTLSServer(handler)
	t.Cleanup(server.Close)
	c := NewClient(fixtureCredentials(loadFixture(t), server.URL))
	c.HTTP.Transport = server.Client().Transport
	return c, server
}
func reply(w http.ResponseWriter, value any, rev int) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("ETag", fmt.Sprintf("\"%d\"", rev))
	json.NewEncoder(w).Encode(value)
}
func serveFixture(t *testing.T, w http.ResponseWriter, r *http.Request, v fixture, revision int) {
	t.Helper()
	if r.Method != "GET" || r.Header.Get("CF-Access-Client-Id") != "test.access" || r.Header.Get("CF-Access-Client-Secret") != "synthetic-token" {
		t.Error("incorrect authentication or mutation request")
	}
	switch r.URL.Path {
	case "/api/v1/profiles":
		reply(w, map[string]any{"profiles": []Profile{fixtureProfile(v)}}, revision)
	case "/api/v1/devices/self/key":
		reply(w, v.key(), revision)
	case "/api/v1/profiles/" + profileID + "/secrets":
		reply(w, map[string]any{"profile": fixtureProfile(v), "secrets": []Secret{v.secret()}}, revision)
	case "/api/v1/secrets":
		reply(w, map[string]any{"secrets": []SecretMetadata{{v.SecretID, "TEST_TOKEN", 1, 1}}}, revision)
	default:
		t.Errorf("unexpected endpoint %s", r.URL.Path)
		w.WriteHeader(404)
	}
}
func TestOnlineEnvironmentAndRotationRetry(t *testing.T) {
	for _, mode := range []string{"stable", "one-conflict", "always-conflict"} {
		t.Run(mode, func(t *testing.T) {
			v := loadFixture(t)
			keyReads := 0
			c, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/v1/devices/self/key" {
					keyReads++
				}
				rev := 1
				if strings.HasSuffix(r.URL.Path, "/secrets") && (mode == "always-conflict" || (mode == "one-conflict" && keyReads == 1)) {
					rev = 2
				}
				serveFixture(t, w, r, v, rev)
			})
			env, err := c.Environment(context.Background(), "agent")
			if mode == "always-conflict" {
				if err == nil || keyReads != 3 {
					t.Fatalf("unbounded/absent retry %d %v", keyReads, err)
				}
				return
			}
			if err != nil || len(env) != 1 || env["TEST_TOKEN"] != v.Plaintext {
				t.Fatalf("wrong environment %v", err)
			}
			if mode == "one-conflict" && keyReads != 2 {
				t.Fatal("did not restart reads")
			}
		})
	}
}
func TestHTTPFailuresDoNotExposeResponse(t *testing.T) {
	for _, code := range []int{401, 403, 404, 429, 500, 503} {
		t.Run(fmt.Sprint(code), func(t *testing.T) {
			c, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(code)
				fmt.Fprint(w, "synthetic-sensitive-error")
			})
			_, err := c.Environment(context.Background(), "agent")
			if err == nil || strings.Contains(err.Error(), "synthetic-sensitive-error") {
				t.Fatal("missing or unsafe error", err)
			}
		})
	}
	for _, kind := range []string{"html", "malformed", "too-large", "no-revision"} {
		t.Run(kind, func(t *testing.T) {
			c, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("ETag", "\"1\"")
				w.Header().Set("Content-Type", "application/json")
				switch kind {
				case "html":
					w.Header().Set("Content-Type", "text/html")
					fmt.Fprint(w, "<html>sign in</html>")
				case "malformed":
					fmt.Fprint(w, "{")
				case "too-large":
					fmt.Fprint(w, strings.Repeat(" ", 10*1024*1024+1))
				case "no-revision":
					w.Header().Del("ETag")
					fmt.Fprint(w, `{"profiles":[]}`)
				}
			})
			if _, err := c.Profiles(context.Background()); err == nil {
				t.Fatal("accepted malformed response")
			}
		})
	}
}
func TestRedirectAndUnavailable(t *testing.T) {
	reached := false
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached = true }))
	defer target.Close()
	c, server := testClient(t, func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 302) })
	if _, err := c.Profiles(context.Background()); err == nil || reached {
		t.Fatal("followed credential-bearing redirect")
	}
	server.Close()
	if _, err := c.Profiles(context.Background()); err == nil {
		t.Fatal("unavailable service succeeded")
	}
}
func TestBundleValidation(t *testing.T) {
	v := loadFixture(t)
	key, _ := binary(v.VEK, 32, 32)
	for _, kind := range []string{"missing", "extra", "duplicate-env", "bad-env", "version", "tampered", "null-mappings", "nul", "invalid-utf8"} {
		t.Run(kind, func(t *testing.T) {
			p := fixtureProfile(v)
			secrets := []Secret{v.secret()}
			switch kind {
			case "missing":
				secrets = []Secret{}
			case "extra":
				secrets = append(secrets, v.secret())
			case "duplicate-env":
				p.Mappings = append(p.Mappings, p.Mappings[0])
			case "bad-env":
				p.Mappings[0].EnvName = "BAD=ENV"
			case "version":
				secrets[0].VEKVersion++
			case "tampered":
				secrets[0].Envelope.Ciphertext = "A" + secrets[0].Envelope.Ciphertext[1:]
			case "null-mappings":
				p.Mappings = nil
			case "nul", "invalid-utf8":
				plain := []byte("a\x00b")
				if kind == "invalid-utf8" {
					plain = []byte{255}
				}
				block, _ := aes.NewCipher(key)
				gcm, _ := cipher.NewGCM(block)
				nonce := make([]byte, 12)
				secrets[0].Envelope.Nonce = base64.RawURLEncoding.EncodeToString(nonce)
				secrets[0].Envelope.Ciphertext = base64.RawURLEncoding.EncodeToString(gcm.Seal(nil, nonce, plain, aad("secret", v.VaultID, v.SecretID, 1, 1)))
			}
			if _, err := decryptBundle(key, v.key(), p, secrets); err == nil {
				t.Fatal("accepted invalid bundle")
			}
		})
	}
}
