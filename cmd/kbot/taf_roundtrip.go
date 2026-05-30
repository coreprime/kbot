package main

import (
	"bytes"
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

func newTAFRoundtripCommand() *cobra.Command {
	var vfsRoot string
	cmd := &cobra.Command{
		Use:   "roundtrip <file.taf>",
		Short: "Verify a TAF re-serializes byte-for-byte",
		Long: `Parse a TAF and re-serialize it, confirming the output is byte-identical
to the input.  A clean result proves kbot's model captures every byte of
the file (a useful guard when adding format support).

Examples:
  kbot taf roundtrip frontend.taf`,
		Args:          cobra.ExactArgs(1),
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(_ *cobra.Command, args []string) error {
			taf, hit, cleanup, err := loadTAF(args[0], vfsRoot, false)
			defer cleanup()
			if err != nil {
				return err
			}
			got, err := taf.Bytes()
			if err != nil {
				return fmt.Errorf("serialize: %w", err)
			}
			if !bytes.Equal(got, hit.Data) {
				return fmt.Errorf("round-trip differs: re-serialized %d bytes vs original %d", len(got), len(hit.Data))
			}
			fmt.Fprintf(os.Stderr, "OK: %s round-trips byte-for-byte (%d bytes, %d frame(s))\n",
				hit.Source, len(got), len(taf.Frames))
			return nil
		},
	}
	cmd.Flags().StringVar(&vfsRoot, "vfs", "", "Mount a TA/TA:K install for bare-name lookups (default: active kbot context)")
	return cmd
}
