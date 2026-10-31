//go:build arm64 && !purego

package pow

import (
	"encoding/binary"
	"os"
)

// neonAvailable 表示本次构建里带了 NEON/SHA3 版本的 Keccak 置换。
const neonAvailable = true

// keccakF23NEON 用 ARMv8.2 SHA3 扩展做 Keccak-f[1600] 的 rounds 1..23。
// 实现在 deepseek_keccak_arm64.s（改编自 Go 标准库，BSD 许可），逐字节等价于 keccakF23Pure。
//
//go:noescape
func keccakF23NEON(s *[25]uint64)

func init() {
	useNEON = detectNEON()
}

// detectNEON 判断本机 CPU 是否支持 SHA3 扩展（HWCAP_SHA3）。
// POW_NO_NEON=1 可强制关闭，便于 A/B 或怀疑硬件指令异常时回退。
func detectNEON() bool {
	if os.Getenv("POW_NO_NEON") != "" {
		return false
	}
	return hwcapSHA3()
}

// hwcapSHA3 从 /proc/self/auxv 读 AT_HWCAP，检查 HWCAP_SHA3（bit 17）。
// 读不到（受限容器等）就保守地退回纯 Go，正确性不受影响。
func hwcapSHA3() bool {
	data, err := os.ReadFile("/proc/self/auxv")
	if err != nil {
		return false
	}
	const atHWCAP = 16
	for i := 0; i+16 <= len(data); i += 16 {
		typ := binary.LittleEndian.Uint64(data[i:])
		val := binary.LittleEndian.Uint64(data[i+8:])
		if typ == 0 {
			break
		}
		if typ == atHWCAP {
			return val&(1<<17) != 0
		}
	}
	return false
}
