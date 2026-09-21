package hush

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func makeFIFO(t *testing.T, path string) {
	t.Helper()
	if err := syscall.Mkfifo(path, 0600); err != nil {
		t.Fatal(err)
	}
}
func TestExecHelper(t *testing.T) {
	if os.Getenv("HUSH_TEST_EXEC") != "1" {
		return
	}
	split := 0
	for i, a := range os.Args {
		if a == "--" {
			split = i + 1
			break
		}
	}
	if split == 0 {
		os.Exit(98)
	}
	if err := Execute(os.Args[split:], map[string]string{"TEST_TOKEN": "synthetic-secret", "OVERRIDE": "profile"}); err != nil {
		fmt.Fprint(os.Stderr, err)
		os.Exit(97)
	}
}
func TestCommandTarget(t *testing.T) {
	if os.Getenv("HUSH_TEST_TARGET") != "1" {
		return
	}
	b := make([]byte, 64)
	n, _ := os.Stdin.Read(b)
	json.NewEncoder(os.Stdout).Encode(map[string]any{"args": os.Args[len(os.Args)-2:], "input": string(b[:n]), "secret": os.Getenv("TEST_TOKEN"), "override": os.Getenv("OVERRIDE"), "inherited": os.Getenv("INHERITED")})
	fmt.Fprint(os.Stderr, "child-stderr")
	os.Exit(23)
}
func helper(t *testing.T, args ...string) *exec.Cmd {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe, append([]string{"-test.run=^TestExecHelper$", "--"}, args...)...)
	cmd.Env = append(os.Environ(), "HUSH_TEST_EXEC=1", "HUSH_TEST_TARGET=1", "OVERRIDE=parent", "INHERITED=keep")
	return cmd
}
func TestExecStreamsArgumentsEnvironmentAndExit(t *testing.T) {
	exe, _ := os.Executable()
	cmd := helper(t, exe, "-test.run=^TestCommandTarget$", "--", "literal $(echo unsafe)", "a b;*")
	cmd.Stdin = strings.NewReader("child-stdin")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 23 {
		t.Fatalf("lost exit status: %v", err)
	}
	if stderr.String() != "child-stderr" {
		t.Fatal("stderr changed")
	}
	var result struct {
		Args                               []string
		Input, Secret, Override, Inherited string
	}
	if err = json.Unmarshal(stdout.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Input != "child-stdin" || result.Secret != "synthetic-secret" || result.Override != "profile" || result.Inherited != "keep" || strings.Join(result.Args, "|") != "literal $(echo unsafe)|a b;*" {
		t.Fatal("exec semantics changed")
	}
}
func TestExecPreservesSignals(t *testing.T) {
	for _, sig := range []syscall.Signal{syscall.SIGTERM, syscall.SIGINT} {
		t.Run(sig.String(), func(t *testing.T) {
			cmd := helper(t, "/bin/sh", "-c", "printf 'ready\n'; exec sleep 30")
			output, err := cmd.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			if err = cmd.Start(); err != nil {
				t.Fatal(err)
			}
			defer cmd.Process.Kill()
			ready := make(chan string, 1)
			go func() { line, _ := bufio.NewReader(output).ReadString('\n'); ready <- line }()
			select {
			case line := <-ready:
				if line != "ready\n" {
					t.Fatal("child not ready")
				}
			case <-time.After(5 * time.Second):
				t.Fatal("child startup timeout")
			}
			if err = cmd.Process.Signal(sig); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() { done <- cmd.Wait() }()
			select {
			case err = <-done:
				e, ok := err.(*exec.ExitError)
				if !ok || e.Sys().(syscall.WaitStatus).Signal() != sig {
					t.Fatalf("signal changed: %v", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("signal did not terminate process")
			}
		})
	}
}
func TestEffectivePATHAndNoImplicitCWD(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "custom")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0700); err != nil {
		t.Fatal(err)
	}
	got, err := lookPath("custom", []string{"PATH=" + dir})
	if err != nil || got != path {
		t.Fatal("ignored effective PATH")
	}
	if _, err = lookPath("custom", []string{"PATH=."}); err == nil {
		t.Fatal("searched implicit working directory")
	}
}
