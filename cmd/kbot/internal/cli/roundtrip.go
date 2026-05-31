package cli

import (
	"crypto/md5"
	"fmt"
)

// MD5Hex returns the lowercase hex MD5 digest of data. Round-trip commands use
// it to compare byte-for-byte fidelity between original and re-encoded assets.
func MD5Hex(data []byte) string {
	h := md5.Sum(data)
	return fmt.Sprintf("%x", h)
}

// PassFail renders a boolean as the "PASS"/"FAIL" labels round-trip summaries
// print.
func PassFail(ok bool) string {
	if ok {
		return "PASS"
	}
	return "FAIL"
}
