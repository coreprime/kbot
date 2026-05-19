package explorer

import (
	"errors"
	"fmt"
	"net"
	"syscall"
	"testing"
)

func TestIsClientDisconnect(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"unrelated", errors.New("some other write error"), false},
		{"ECONNRESET direct", syscall.ECONNRESET, true},
		{"EPIPE direct", syscall.EPIPE, true},
		{"wrapped ECONNRESET", fmt.Errorf("wrap: %w", syscall.ECONNRESET), true},
		// net.OpError is what the http server actually surfaces.
		{"net.OpError EPIPE", &net.OpError{Op: "write", Err: syscall.EPIPE}, true},
		{"net.OpError ECONNRESET", &net.OpError{Op: "write", Err: syscall.ECONNRESET}, true},
		// String fallback for wrapping that defeats errors.Is.
		{"stringly-typed", errors.New("write tcp: connection reset by peer"), true},
		{"broken pipe text", errors.New("write tcp 127.0.0.1:8000: broken pipe"), true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isClientDisconnect(tc.err); got != tc.want {
				t.Errorf("isClientDisconnect(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}
