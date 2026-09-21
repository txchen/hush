package hush

import (
	"errors"
	"os"
	"os/exec"
	"sort"
	"strings"
	"syscall"
)

// Replace the CLI process so terminal, signal, and exit-status semantics belong
// directly to the requested program. No shell and no plaintext-bearing parent
// process remain after a successful exec.
func Execute(args []string, overrides map[string]string) error {
	if len(args) == 0 || args[0] == "" {
		return errors.New("exec requires a command after --")
	}
	env := mergeEnvironment(os.Environ(), overrides)
	path, err := lookPath(args[0], env)
	if err != nil {
		return errors.New("command not found or not executable")
	}
	if err = syscall.Exec(path, args, env); err != nil {
		return errors.New("could not execute command")
	}
	return nil
}
func mergeEnvironment(inherited []string, overrides map[string]string) []string {
	values := map[string]string{}
	for _, entry := range inherited {
		k, v, ok := strings.Cut(entry, "=")
		if ok {
			values[k] = v
		}
	}
	for k, v := range overrides {
		values[k] = v
	}
	keys := make([]string, 0, len(values))
	for k := range values {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	result := make([]string, 0, len(keys))
	for _, k := range keys {
		result = append(result, k+"="+values[k])
	}
	return result
}
func lookPath(name string, env []string) (string, error) {
	if strings.Contains(name, "/") {
		return exec.LookPath(name)
	}
	// Resolve using the effective PATH, including an explicit Profile override.
	path := ""
	for _, entry := range env {
		if strings.HasPrefix(entry, "PATH=") {
			path = strings.TrimPrefix(entry, "PATH=")
		}
	}
	for _, dir := range strings.Split(path, ":") {
		if dir == "" {
			continue
		} // Do not implicitly execute from the current directory.
		candidate := dir + "/" + name
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() && info.Mode()&0111 != 0 {
			if !strings.HasPrefix(candidate, "/") {
				return "", exec.ErrDot
			}
			return candidate, nil
		}
	}
	return "", exec.ErrNotFound
}
