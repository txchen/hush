package hush

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hpke"
	"encoding/base64"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

var errProtocol = errors.New("invalid or unauthenticated vault data")
var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var envPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
var clientPattern = regexp.MustCompile(`^[A-Za-z0-9_-]+\.access$`)

const maxVersion = 9007199254740990

type Envelope struct {
	Format     int    `json:"format"`
	Algorithm  string `json:"algorithm"`
	Nonce      string `json:"nonce,omitempty"`
	Enc        string `json:"enc,omitempty"`
	Ciphertext string `json:"ciphertext"`
}
type Secret struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Version    int64    `json:"version"`
	VEKVersion int64    `json:"vek_version"`
	Envelope   Envelope `json:"envelope"`
}
type Mapping struct {
	SecretID string `json:"secret_id"`
	EnvName  string `json:"env_name"`
}
type Profile struct {
	ID       string    `json:"id"`
	Name     string    `json:"name"`
	Mappings []Mapping `json:"mappings"`
}
type DeviceKey struct {
	DeviceID   string   `json:"device_id"`
	VaultID    string   `json:"vault_id"`
	VEKVersion int64    `json:"vek_version"`
	WrappedVEK Envelope `json:"wrapped_vek"`
}

func validVersion(v int64) bool { return v > 0 && v <= maxVersion }
func validName(s string) bool {
	return s != "" && utf8.ValidString(s) && len([]rune(s)) <= 128 && s == strings.TrimSpace(s) && !strings.ContainsFunc(s, unicode.IsControl)
}
func binary(s string, min, max int) ([]byte, error) {
	if len(s) > (max*4+2)/3 {
		return nil, errProtocol
	}
	b, err := base64.RawURLEncoding.Strict().DecodeString(s)
	if err != nil || len(b) < min || len(b) > max || base64.RawURLEncoding.EncodeToString(b) != s {
		return nil, errProtocol
	}
	return b, nil
}
func aad(fields ...any) []byte {
	s := []string{"hush", "1"}
	for _, f := range fields {
		s = append(s, fmt.Sprint(f))
	}
	return []byte(strings.Join(s, "\n"))
}
func unwrap(private []byte, deviceID, vaultID string, k DeviceKey) ([]byte, error) {
	if k.DeviceID != deviceID || !uuidPattern.MatchString(k.VaultID) || (vaultID != "" && k.VaultID != vaultID) || !validVersion(k.VEKVersion) {
		return nil, errProtocol
	}
	e := k.WrappedVEK
	if e.Format != 1 || e.Algorithm != "HPKE-X25519-HKDF-SHA256-AES-256-GCM" || e.Nonce != "" {
		return nil, errProtocol
	}
	enc, err := binary(e.Enc, 32, 32)
	if err != nil {
		return nil, err
	}
	ct, err := binary(e.Ciphertext, 48, 48)
	if err != nil {
		return nil, err
	}
	key, err := ecdh.X25519().NewPrivateKey(private)
	if err != nil {
		return nil, errProtocol
	}
	kem, err := hpke.NewDHKEMPrivateKey(key)
	if err != nil {
		return nil, errProtocol
	}
	recipient, err := hpke.NewRecipient(enc, kem, hpke.HKDFSHA256(), hpke.AES256GCM(), aad("device-vek"))
	if err != nil {
		return nil, errProtocol
	}
	plain, err := recipient.Open(aad("device", k.VaultID, k.DeviceID, k.VEKVersion), ct)
	if err != nil || len(plain) != 32 {
		clear(plain)
		return nil, errProtocol
	}
	return plain, nil
}
func decrypt(key []byte, vaultID string, s Secret) ([]byte, error) {
	if len(key) != 32 || !uuidPattern.MatchString(vaultID) || !uuidPattern.MatchString(s.ID) || !validVersion(s.Version) || !validVersion(s.VEKVersion) {
		return nil, errProtocol
	}
	e := s.Envelope
	if e.Format != 1 || e.Algorithm != "AES-256-GCM" || e.Enc != "" {
		return nil, errProtocol
	}
	nonce, err := binary(e.Nonce, 12, 12)
	if err != nil {
		return nil, err
	}
	ct, err := binary(e.Ciphertext, 16, 12200)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, errProtocol
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, errProtocol
	}
	plain, err := gcm.Open(nil, nonce, ct, aad("secret", vaultID, s.ID, s.Version, s.VEKVersion))
	if err != nil {
		return nil, errProtocol
	}
	return plain, nil
}
