package main

import (
	"fmt"
	"os"

	"hush.local/cli/internal/hush"
)

var version = "dev"

func main() {
	if err := hush.DefaultApp(version).Run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "hush:", err)
		os.Exit(1)
	}
}
