//go:build !arm64 || purego

package pow

// neonAvailable 表示本次构建里没有 NEON/SHA3 汇编版本（非 arm64 或 -tags purego）。
const neonAvailable = false

// keccakF23NEON 在无汇编实现时退化为纯 Go。
// 正常路径下 useNEON 恒为 false，不会走到这里，但保留符号让调度处能统一编译。
func keccakF23NEON(s *[25]uint64) { keccakF23Pure(s) }
