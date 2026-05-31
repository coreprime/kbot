package ctx

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/internal/kbotctx"
)

// ANSI escape codes for the interactive prompt.  Kept tiny on purpose:
// no TUI dependency, plain stdin/stdout with optional colour.
const (
	ansiReset  = "\x1b[0m"
	ansiBold   = "\x1b[1m"
	ansiDim    = "\x1b[2m"
	ansiCyan   = "\x1b[36m"
	ansiGreen  = "\x1b[32m"
	ansiYellow = "\x1b[33m"
	ansiRed    = "\x1b[31m"
)

func newCtxHereCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "here",
		Short: "Adopt the current directory as a kbot context",
		Long: `If the current directory is already registered as a kbot context,
switch to it.  Otherwise prompt for an alias, game type, and an
optional version label, then register the directory as a new context
and select it.

The interactive prompt requires a TTY.  Use 'kbot ctx add' for
non-interactive setups.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runCtxHere(cmd, os.Getwd)
		},
	}
}

// runCtxHere is the testable core: getwd is injected so tests can
// point at fixtures without touching the process cwd.
func runCtxHere(cmd *cobra.Command, getwd func() (string, error)) error {
	cwd, err := getwd()
	if err != nil {
		return fmt.Errorf("get current directory: %w", err)
	}
	cwd, err = filepath.Abs(cwd)
	if err != nil {
		return fmt.Errorf("resolve absolute path: %w", err)
	}

	cfg, err := kbotctx.Load()
	if err != nil {
		return err
	}

	if alias, ok := findContextByPath(cfg, cwd); ok {
		if cfg.Current == alias {
			_, _ = fmt.Fprintf(cmd.ErrOrStderr(), "Already on context %q (%s)\n", alias, cwd)
			return nil
		}
		if err := cfg.Use(alias); err != nil {
			return err
		}
		if err := cfg.Save(); err != nil {
			return err
		}
		_, _ = fmt.Fprintf(cmd.ErrOrStderr(), "Switched current context to %q (%s)\n", alias, cwd)
		return nil
	}

	alias, entry, err := promptForContext(cmd.InOrStdin(), cmd.ErrOrStderr(), cwd, cfg)
	if err != nil {
		return err
	}

	if err := cfg.Add(alias, entry, false); err != nil {
		return err
	}
	if err := cfg.Use(alias); err != nil {
		return err
	}
	if err := cfg.Save(); err != nil {
		return err
	}

	colour := supportsColor(cmd.ErrOrStderr())
	_, _ = fmt.Fprintf(cmd.ErrOrStderr(), "\n%sAdded context %q -> %s and set as current%s\n",
		bold(colour), alias, cwd, sgrReset(colour))
	return nil
}

// findContextByPath looks for a registered context whose recorded path
// matches the given absolute path.  Matching uses filepath.Clean to
// tolerate trailing slashes / dot segments.
func findContextByPath(cfg *kbotctx.Config, path string) (string, bool) {
	target := filepath.Clean(path)
	for _, alias := range cfg.Aliases() {
		if filepath.Clean(cfg.Contexts[alias].Path) == target {
			return alias, true
		}
	}
	return "", false
}

// promptForContext drives the interactive registration flow.
func promptForContext(in io.Reader, out io.Writer, cwd string, cfg *kbotctx.Config) (string, kbotctx.Context, error) {
	if !isInteractive(in, out) {
		return "", kbotctx.Context{}, errors.New("kbot ctx here needs an interactive terminal (try `kbot ctx add` instead)")
	}

	colour := supportsColor(out)
	reader := bufio.NewReader(in)

	printHeader(out, cwd, colour)

	alias, err := promptAlias(reader, out, suggestAlias(cwd, cfg), cfg, colour)
	if err != nil {
		return "", kbotctx.Context{}, err
	}

	game, err := promptGame(reader, out, colour)
	if err != nil {
		return "", kbotctx.Context{}, err
	}

	version, err := promptVersion(reader, out, colour)
	if err != nil {
		return "", kbotctx.Context{}, err
	}

	if err := confirmSummary(reader, out, alias, game, version, cwd, colour); err != nil {
		return "", kbotctx.Context{}, err
	}

	return alias, kbotctx.Context{Path: cwd, Game: game, Version: version}, nil
}

// suggestAlias picks a sensible default alias from the directory's
// basename.  It is unique within the current config — if "totala"
// already exists we suggest "totala-2", etc.
func suggestAlias(cwd string, cfg *kbotctx.Config) string {
	base := filepath.Base(cwd)
	base = strings.ToLower(strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-', r == '_':
			return r
		case r >= 'A' && r <= 'Z':
			return r + 32
		}
		return '-'
	}, base))
	base = strings.Trim(base, "-_")
	if base == "" {
		base = "context"
	}
	candidate := base
	for i := 2; ; i++ {
		if _, taken := cfg.Contexts[candidate]; !taken {
			return candidate
		}
		candidate = fmt.Sprintf("%s-%d", base, i)
	}
}

func promptAlias(r *bufio.Reader, out io.Writer, suggested string, cfg *kbotctx.Config, colour bool) (string, error) {
	for {
		label := fmt.Sprintf("Alias %s[%s]%s", dim(colour), suggested, sgrReset(colour))
		_, _ = fmt.Fprintf(out, "  %s%s%s %s: ", cyan(colour), "▸", sgrReset(colour), label)
		line, err := readLine(r)
		if err != nil {
			return "", err
		}
		line = strings.TrimSpace(line)
		if line == "" {
			line = suggested
		}
		// Cheap re-validation via Add's rules without committing.
		probe := *cfg // shallow copy is fine, Add only mutates Contexts map
		probe.Contexts = map[string]kbotctx.Context{}
		for k, v := range cfg.Contexts {
			probe.Contexts[k] = v
		}
		if err := probe.Add(line, kbotctx.Context{Path: "/", Game: kbotctx.GameCustom}, false); err != nil {
			printErr(out, err, colour)
			continue
		}
		return line, nil
	}
}

func promptGame(r *bufio.Reader, out io.Writer, colour bool) (string, error) {
	games := []struct {
		key  string
		desc string
	}{
		{kbotctx.GameTotalA, "Total Annihilation (Cavedog)"},
		{kbotctx.GameTAKingdoms, "Total Annihilation: Kingdoms"},
		{kbotctx.GameCustom, "Custom — mod, partial install, or non-TA tree"},
	}

	_, _ = fmt.Fprintf(out, "\n  %s%sGame type%s\n", cyan(colour), "▸ ", sgrReset(colour))
	for i, g := range games {
		_, _ = fmt.Fprintf(out, "    %s%d)%s %-12s %s%s%s\n",
			bold(colour), i+1, sgrReset(colour),
			g.key,
			dim(colour), g.desc, sgrReset(colour))
	}

	for {
		_, _ = fmt.Fprintf(out, "  Select %s[1-%d]%s: ", dim(colour), len(games), sgrReset(colour))
		line, err := readLine(r)
		if err != nil {
			return "", err
		}
		line = strings.TrimSpace(line)
		if line == "" {
			line = "1"
		}
		// Accept either the index or the game key directly.
		if n, err := strconv.Atoi(line); err == nil {
			if n >= 1 && n <= len(games) {
				return games[n-1].key, nil
			}
		} else if kbotctx.IsKnownGame(line) {
			return line, nil
		}
		printErr(out, fmt.Errorf("enter a number 1-%d or one of: %s", len(games), strings.Join(kbotctx.ValidGames, ", ")), colour)
	}
}

func promptVersion(r *bufio.Reader, out io.Writer, colour bool) (string, error) {
	_, _ = fmt.Fprintf(out, "\n  %s%sVersion %s(optional, press Enter to skip)%s: ",
		cyan(colour), "▸ ", dim(colour), sgrReset(colour))
	line, err := readLine(r)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(line), nil
}

func confirmSummary(r *bufio.Reader, out io.Writer, alias, game, version, cwd string, colour bool) error {
	version = strings.TrimSpace(version)
	if version == "" {
		version = "(none)"
	}
	_, _ = fmt.Fprintf(out, "\n  %sRegister this context?%s\n", bold(colour), sgrReset(colour))
	_, _ = fmt.Fprintf(out, "    Alias:   %s%s%s\n", green(colour), alias, sgrReset(colour))
	_, _ = fmt.Fprintf(out, "    Game:    %s%s%s\n", green(colour), game, sgrReset(colour))
	_, _ = fmt.Fprintf(out, "    Version: %s%s%s\n", green(colour), version, sgrReset(colour))
	_, _ = fmt.Fprintf(out, "    Path:    %s%s%s\n", green(colour), cwd, sgrReset(colour))

	for {
		_, _ = fmt.Fprintf(out, "  %sConfirm? %s[Y/n]%s: ", cyan(colour), dim(colour), sgrReset(colour))
		line, err := readLine(r)
		if err != nil {
			return err
		}
		line = strings.ToLower(strings.TrimSpace(line))
		switch line {
		case "", "y", "yes":
			return nil
		case "n", "no":
			return errors.New("cancelled")
		default:
			printErr(out, errors.New("please answer y or n"), colour)
		}
	}
}

func printHeader(out io.Writer, cwd string, colour bool) {
	const width = 60
	bar := strings.Repeat("─", width)
	title := "Register kbot context"
	pathLine := truncateLeft(cwd, width-4)

	_, _ = fmt.Fprintln(out)
	_, _ = fmt.Fprintf(out, "  %s┌%s┐%s\n", cyan(colour), bar, sgrReset(colour))
	_, _ = fmt.Fprintf(out, "  %s│%s %s%-*s%s %s│%s\n",
		cyan(colour), sgrReset(colour),
		bold(colour), width-2, title, sgrReset(colour),
		cyan(colour), sgrReset(colour))
	_, _ = fmt.Fprintf(out, "  %s│%s %s%-*s%s %s│%s\n",
		cyan(colour), sgrReset(colour),
		dim(colour), width-2, pathLine, sgrReset(colour),
		cyan(colour), sgrReset(colour))
	_, _ = fmt.Fprintf(out, "  %s└%s┘%s\n\n", cyan(colour), bar, sgrReset(colour))
}

func truncateLeft(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return "…" + s[len(s)-(max-1):]
}

func printErr(out io.Writer, err error, colour bool) {
	_, _ = fmt.Fprintf(out, "    %s✗ %s%s\n", red(colour), err.Error(), sgrReset(colour))
}

func readLine(r *bufio.Reader) (string, error) {
	line, err := r.ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	return strings.TrimRight(line, "\r\n"), nil
}

// ── tiny ANSI helpers — return empty strings when colour is off ─────────────

func supportsColor(w io.Writer) bool {
	f, ok := w.(*os.File)
	if !ok {
		return false
	}
	stat, err := f.Stat()
	if err != nil {
		return false
	}
	return (stat.Mode() & os.ModeCharDevice) != 0
}

func isInteractive(in io.Reader, out io.Writer) bool {
	if f, ok := in.(*os.File); ok {
		if stat, err := f.Stat(); err == nil {
			if (stat.Mode() & os.ModeCharDevice) == 0 {
				return false
			}
		}
	}
	// Out side is a soft hint — we don't bail just because stdout is
	// piped, because the user may want the result captured.
	_ = out
	return true
}

func bold(colour bool) string {
	if colour {
		return ansiBold
	}
	return ""
}

func sgrReset(colour bool) string {
	if colour {
		return ansiReset
	}
	return ""
}

func dim(colour bool) string {
	if colour {
		return ansiDim
	}
	return ""
}
func cyan(colour bool) string {
	if colour {
		return ansiCyan
	}
	return ""
}
func green(colour bool) string {
	if colour {
		return ansiGreen
	}
	return ""
}
func red(colour bool) string {
	if colour {
		return ansiRed
	}
	return ""
}

// Reference the yellow constant so future tweaks can use it without
// reintroducing an "unused" lint error.
var _ = ansiYellow
