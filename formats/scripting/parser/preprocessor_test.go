package parser

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/coreprime/kbot/filesystem"
	"github.com/coreprime/kbot/testutil"
)

func TestPreprocessorDefine(t *testing.T) {
	fs := filesystem.NewMemoryFileSystem()
	p := NewPreprocessor(fs)
	
	input := `#define SIG_AIM 2
#define SMOKEPIECE1 base
signal SIG_AIM;
emit-sfx from SMOKEPIECE1;`

	result, err := p.ProcessContent(input, ".")
	if err != nil {
		t.Fatalf("processContent failed: %v", err)
	}

	if !strings.Contains(result, "signal 2;") {
		t.Errorf("Expected 'signal 2;', got:\n%s", result)
	}
	if !strings.Contains(result, "emit-sfx from base;") {
		t.Errorf("Expected 'emit-sfx from base;', got:\n%s", result)
	}
}

func TestPreprocessorIfdef(t *testing.T) {
	fs := filesystem.NewMemoryFileSystem()
	p := NewPreprocessor(fs)
	
	input := `#define SMOKEPIECE3 1
#ifdef SMOKEPIECE4
line1
#else
line2
#endif
#ifdef SMOKEPIECE3
line3
#endif`

	result, err := p.ProcessContent(input, ".")
	if err != nil {
		t.Fatalf("processContent failed: %v", err)
	}

	if strings.Contains(result, "line1") {
		t.Errorf("line1 should not be present (SMOKEPIECE4 not defined)")
	}
	if !strings.Contains(result, "line2") {
		t.Errorf("line2 should be present (#else branch)")
	}
	if !strings.Contains(result, "line3") {
		t.Errorf("line3 should be present (SMOKEPIECE3 is defined)")
	}
}

func TestPreprocessorIfndef(t *testing.T) {
	fs := filesystem.NewMemoryFileSystem()
	p := NewPreprocessor(fs)
	
	input := `#ifndef SMOKE_H_
#define SMOKE_H_
content here
#endif`

	result, err := p.ProcessContent(input, ".")
	if err != nil {
		t.Fatalf("processContent failed: %v", err)
	}

	if !strings.Contains(result, "content here") {
		t.Errorf("Expected 'content here', got:\n%s", result)
	}
}

func TestPreprocessorUndef(t *testing.T) {
	fs := filesystem.NewMemoryFileSystem()
	p := NewPreprocessor(fs)
	
	input := `#define NUM_SMOKE_PIECES 4
before NUM_SMOKE_PIECES
#undef NUM_SMOKE_PIECES
after NUM_SMOKE_PIECES`

	result, err := p.ProcessContent(input, ".")
	if err != nil {
		t.Fatalf("processContent failed: %v", err)
	}

	lines := strings.Split(strings.TrimSpace(result), "\n")
	if len(lines) < 2 {
		t.Fatalf("Expected at least 2 lines, got: %v", lines)
	}

	if !strings.Contains(lines[0], "before 4") {
		t.Errorf("Expected 'before 4', got: %s", lines[0])
	}
	if !strings.Contains(lines[1], "after NUM_SMOKE_PIECES") {
		t.Errorf("Expected 'after NUM_SMOKE_PIECES' (not expanded), got: %s", lines[1])
	}
}

func TestPreprocessorInclude(t *testing.T) {
	// Create temp files for testing
	tmpDir := t.TempDir()
	
	// Create header file
	headerPath := filepath.Join(tmpDir, "test.h")
	headerContent := `#ifndef TEST_H
#define TEST_H
#define VALUE 42
#endif`
	if err := os.WriteFile(headerPath, []byte(headerContent), 0644); err != nil {
		t.Fatalf("Failed to create header: %v", err)
	}

	// Create main file
	mainPath := filepath.Join(tmpDir, "main.bos")
	mainContent := `#include "test.h"
result = VALUE;`
	if err := os.WriteFile(mainPath, []byte(mainContent), 0644); err != nil {
		t.Fatalf("Failed to create main file: %v", err)
	}

	// Process
	fs, err := filesystem.NewPhysicalFileSystem(tmpDir)
	if err != nil {
		t.Fatalf("Failed to create filesystem: %v", err)
	}
	defer func() { _ = fs.Close() }()
	
	p := NewPreprocessor(fs)
	result, err := p.Process("main.bos")
	if err != nil {
		t.Fatalf("Process failed: %v", err)
	}

	if !strings.Contains(result, "result = 42;") {
		t.Errorf("Expected 'result = 42;', got:\n%s", result)
	}
}

func TestPreprocessorRealFile(t *testing.T) {
	scriptsDir := testutil.UnpackedDir(t, "scripts")
	fs, err := filesystem.NewPhysicalFileSystem(scriptsDir)
	if err != nil {
		t.Fatalf("Failed to create filesystem: %v", err)
	}
	defer func() { _ = fs.Close() }()
	
	p := NewPreprocessor(fs)
	
	result, err := p.Process("cormstor.bos")
	if err != nil {
		t.Fatalf("Process failed: %v", err)
	}

	// Should have expanded includes
	if !strings.Contains(result, "SmokeUnit()") {
		t.Errorf("Expected SmokeUnit() function from smokeunit.h")
	}
	
	// Should have expanded defines
	if strings.Contains(result, "SMOKEPIECE1") {
		t.Errorf("SMOKEPIECE1 should be expanded to 'base'")
	}
	
	// Should have actual function
	if !strings.Contains(result, "Create()") {
		t.Errorf("Expected Create() function")
	}
}
