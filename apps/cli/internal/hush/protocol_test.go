package hush

import (
	"encoding/json"
	"os"
	"testing"
)

type fixture struct {
	VaultID    string   `json:"vault_id"`
	SecretID   string   `json:"secret_id"`
	DeviceID   string   `json:"device_id"`
	PrivateKey string   `json:"device_private_key"`
	VEK        string   `json:"vek"`
	Plaintext  string   `json:"plaintext"`
	Secret     Envelope `json:"secret"`
	DeviceWrap Envelope `json:"device_wrap"`
}

func loadFixture(t *testing.T) fixture {
	t.Helper()
	b, err := os.ReadFile("../../../../contracts/fixtures/crypto-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var v fixture
	if err = json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}
func (v fixture) key() DeviceKey { return DeviceKey{v.DeviceID, v.VaultID, 1, v.DeviceWrap} }
func (v fixture) secret() Secret { return Secret{v.SecretID, "TEST_TOKEN", 1, 1, v.Secret} }
func TestProtocolFixture(t *testing.T) {
	v := loadFixture(t)
	private, err := binary(v.PrivateKey, 32, 32)
	if err != nil {
		t.Fatal(err)
	}
	vek, err := unwrap(private, v.DeviceID, v.VaultID, v.key())
	if err != nil {
		t.Fatal(err)
	}
	defer clear(vek)
	expected, _ := binary(v.VEK, 32, 32)
	if string(vek) != string(expected) {
		t.Fatal("VEK mismatch")
	}
	plain, err := decrypt(vek, v.VaultID, v.secret())
	if err != nil || string(plain) != v.Plaintext {
		t.Fatalf("decrypt mismatch: %v", err)
	}
	for _, change := range []func(*DeviceKey){
		func(k *DeviceKey) { k.DeviceID = "44444444-4444-4444-8444-444444444444" },
		func(k *DeviceKey) { k.VEKVersion++ },
		func(k *DeviceKey) { k.WrappedVEK.Enc = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
		func(k *DeviceKey) { k.WrappedVEK.Format = 2 },
	} {
		k := v.key()
		change(&k)
		if _, err = unwrap(private, v.DeviceID, v.VaultID, k); err == nil {
			t.Fatal("accepted invalid device wrapping")
		}
	}
	for _, change := range []func(*Secret){
		func(s *Secret) { s.Version++ }, func(s *Secret) { s.VEKVersion++ },
		func(s *Secret) { s.Envelope.Nonce = "AA" }, func(s *Secret) { s.Envelope.Format = 2 },
		func(s *Secret) { s.Envelope.Ciphertext = "A" + s.Envelope.Ciphertext[1:] },
		func(s *Secret) { s.ID = "bad\nid" },
	} {
		s := v.secret()
		change(&s)
		if _, err = decrypt(vek, v.VaultID, s); err == nil {
			t.Fatal("accepted invalid secret")
		}
	}
	if _, err = unwrap(private, v.DeviceID, "44444444-4444-4444-8444-444444444444", v.key()); err == nil {
		t.Fatal("accepted another vault")
	}
}
func TestCanonicalBinary(t *testing.T) {
	for _, value := range []string{"AA=", "AB", "AA\n", "++", "A"} {
		if _, err := binary(value, 1, 1); err == nil {
			t.Fatalf("accepted %q", value)
		}
	}
}
