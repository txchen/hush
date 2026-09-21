package hush

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

var revisionPattern = regexp.MustCompile(`^"[1-9][0-9]{0,15}"$`)

type Client struct {
	Credentials Credentials
	HTTP        *http.Client
}

func NewClient(c Credentials) *Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	// Only trust the configured HTTPS origin; never forward Access credentials on redirects.
	return &Client{c, &http.Client{Timeout: 15 * time.Second, Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}
func (c *Client) get(ctx context.Context, path string, dest any) (string, error) {
	if err := c.Credentials.validate(); err != nil {
		return "", err
	}
	if c.Credentials.ClientSecret == "" {
		return "", errors.New("Access credentials missing; complete Web enrollment and run hush login")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.Credentials.URL+"/api/v1"+path, nil)
	if err != nil {
		return "", errors.New("cannot create service request")
	}
	req.Header.Set("CF-Access-Client-Id", c.Credentials.ClientID)
	req.Header.Set("CF-Access-Client-Secret", c.Credentials.ClientSecret)
	req.Header.Set("Accept", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return "", errors.New("service request failed; check connectivity, TLS certificates, and service availability")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		switch resp.StatusCode {
		case 401, 403:
			return "", errors.New("access denied; check Access credentials, enrollment, and revocation")
		case 404:
			return "", errors.New("requested vault resource was not found")
		case 301, 302, 303, 307, 308:
			return "", errors.New("service redirected the request; check URL and Access Service Auth policy")
		default:
			return "", fmt.Errorf("service returned HTTP %d", resp.StatusCode)
		}
	}
	media, _, err := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		return "", errors.New("service returned non-JSON data; check Access Service Auth policy")
	}
	const limit = 10 * 1024 * 1024
	b, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	defer clear(b)
	if err != nil || len(b) > limit {
		return "", errors.New("service response is unreadable or too large")
	}
	if !utf8.Valid(b) || json.Unmarshal(b, dest) != nil {
		return "", errors.New("service returned invalid JSON")
	}
	revision := resp.Header.Get("ETag")
	if !revisionPattern.MatchString(revision) {
		return "", errors.New("service response has no valid vault revision")
	}
	return revision, nil
}
func (c *Client) Key(ctx context.Context) (DeviceKey, []byte, string, error) {
	var k DeviceKey
	rev, err := c.get(ctx, "/devices/self/key", &k)
	if err != nil {
		return k, nil, "", err
	}
	raw, err := binary(c.Credentials.PrivateKey, 32, 32)
	if err != nil {
		return k, nil, "", err
	}
	defer clear(raw)
	vek, err := unwrap(raw, c.Credentials.DeviceID, c.Credentials.VaultID, k)
	return k, vek, rev, err
}
func (c *Client) Profiles(ctx context.Context) ([]Profile, error) {
	var result struct {
		Profiles []Profile `json:"profiles"`
	}
	_, err := c.get(ctx, "/profiles", &result)
	if err != nil {
		return nil, err
	}
	if result.Profiles == nil || len(result.Profiles) > 100 {
		return nil, errProtocol
	}
	ids, names := map[string]bool{}, map[string]bool{}
	for _, p := range result.Profiles {
		if err = validateProfile(p); err != nil || ids[p.ID] || names[p.Name] {
			return nil, errProtocol
		}
		ids[p.ID] = true
		names[p.Name] = true
	}
	return result.Profiles, nil
}

type SecretMetadata struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Version    int64  `json:"version"`
	VEKVersion int64  `json:"vek_version"`
}

func (c *Client) Secrets(ctx context.Context) ([]SecretMetadata, error) {
	var result struct {
		Secrets []SecretMetadata `json:"secrets"`
	}
	_, err := c.get(ctx, "/secrets", &result)
	if err != nil {
		return nil, err
	}
	if result.Secrets == nil || len(result.Secrets) > 500 {
		return nil, errProtocol
	}
	ids, names := map[string]bool{}, map[string]bool{}
	for _, s := range result.Secrets {
		if !uuidPattern.MatchString(s.ID) || !validName(s.Name) || !validVersion(s.Version) || !validVersion(s.VEKVersion) || ids[s.ID] || names[s.Name] {
			return nil, errProtocol
		}
		ids[s.ID] = true
		names[s.Name] = true
	}
	return result.Secrets, nil
}
func validateProfile(p Profile) error {
	if !uuidPattern.MatchString(p.ID) || !validName(p.Name) || p.Mappings == nil || len(p.Mappings) > 500 {
		return errProtocol
	}
	names := map[string]bool{}
	for _, m := range p.Mappings {
		if !uuidPattern.MatchString(m.SecretID) || len(m.EnvName) > 128 || !envPattern.MatchString(m.EnvName) || names[m.EnvName] {
			return errProtocol
		}
		names[m.EnvName] = true
	}
	return nil
}

// Environment only returns after all selected ciphertexts have authenticated.
// Equal revisions bind separate reads to a single service snapshot. A rotation
// or another write between requests causes a bounded restart from fresh inputs.
func (c *Client) Environment(ctx context.Context, profile string) (map[string]string, error) {
	for attempt := 0; attempt < 3; attempt++ {
		profiles, err := c.Profiles(ctx)
		if err != nil {
			return nil, err
		}
		var selected *Profile
		for i := range profiles {
			if profiles[i].Name == profile {
				selected = &profiles[i]
				break
			}
		}
		if selected == nil {
			return nil, errors.New("profile not found")
		}
		k, vek, keyRevision, err := c.Key(ctx)
		if err != nil {
			return nil, err
		}
		var bundle struct {
			Profile Profile  `json:"profile"`
			Secrets []Secret `json:"secrets"`
		}
		revision, err := c.get(ctx, "/profiles/"+selected.ID+"/secrets", &bundle)
		if err != nil {
			clear(vek)
			return nil, err
		}
		if revision != keyRevision {
			clear(vek)
			continue
		}
		if bundle.Profile.ID != selected.ID || bundle.Profile.Name != profile {
			clear(vek)
			return nil, errProtocol
		}
		result, err := decryptBundle(vek, k, bundle.Profile, bundle.Secrets)
		clear(vek)
		return result, err
	}
	return nil, errors.New("vault kept changing; retry the command")
}
func decryptBundle(vek []byte, k DeviceKey, p Profile, secrets []Secret) (map[string]string, error) {
	if err := validateProfile(p); err != nil {
		return nil, err
	}
	if secrets == nil || len(secrets) > 500 {
		return nil, errProtocol
	}
	selected := map[string]bool{}
	for _, m := range p.Mappings {
		selected[m.SecretID] = true
	}
	if len(selected) != len(secrets) {
		return nil, errProtocol
	}
	values := map[string]string{}
	for _, s := range secrets {
		if !selected[s.ID] || s.VEKVersion != k.VEKVersion || !validName(s.Name) {
			return nil, errProtocol
		}
		if _, exists := values[s.ID]; exists {
			return nil, errProtocol
		}
		plain, err := decrypt(vek, k.VaultID, s)
		if err != nil {
			return nil, err
		}
		if !utf8.Valid(plain) || strings.IndexByte(string(plain), 0) >= 0 {
			clear(plain)
			return nil, errors.New("secret cannot be represented as an environment variable")
		}
		values[s.ID] = string(plain)
		clear(plain)
	}
	result := map[string]string{}
	for _, m := range p.Mappings {
		value, ok := values[m.SecretID]
		if !ok {
			return nil, errProtocol
		}
		result[m.EnvName] = value
	}
	return result, nil
}
