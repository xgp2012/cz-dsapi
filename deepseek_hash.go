// Package pow 提供 DeepSeekHashV1 纯 Go 实现。
//
// DeepSeekHashV1 = SHA3-256 但跳过 Keccak-f[1600] 的 round 0（只做 rounds 1..23）。
// 其余参数与 SHA3-256 完全一致：rate=136、padding 0x06 + 0x80、输出 32 字节。
//
// 该实现是 cmd/powd 求解器的核心：一次 nonce 搜索要对同一前缀反复做
// Keccak 置换，所以这里把 25 个 lane 全部放在局部变量里，避免数组反复读写。
package pow

import (
	"encoding/binary"
	"math/bits"
)

// hashRate 是 SHA3-256 的 rate（吸收/挤出块大小，字节）。
const hashRate = 136

// rc 是 Keccak-f[1600] 的 24 轮轮常数。DeepSeekHashV1 跳过 round 0，故只用 rc[1..23]。
var rc = [24]uint64{
	0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
	0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
	0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
	0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
	0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
	0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
}

func rotl64(v uint64, k uint) uint64 { return bits.RotateLeft64(v, int(k)) }

// useNEON 决定 keccakF23 是否走 ARMv8.2 SHA3 汇编实现。
// 构建标签决定 neonAvailable，arm64 上再按运行时 HWCAP_SHA3 打开（见 deepseek_keccak_arm64.go）。
var useNEON = neonAvailable

// keccakF23 对 25 个 lane 做 rounds 1..23 的 Keccak-f[1600] 置换（原地）。
// 有 NEON/SHA3 汇编实现时用它（约 1.6x 提速），否则走纯 Go 版本。
func keccakF23(s *[25]uint64) {
	if useNEON {
		keccakF23NEON(s)
		return
	}
	keccakF23Pure(s)
}

// keccakF23Pure 是逐 lane 的纯 Go 实现，也是所有汇编实现的正确性基准。
//
// 相比用 [25]uint64 数组 + 下标循环，展开成 25 个局部变量能让编译器把
// lane 尽量留在寄存器里，是整条求解链路上最热的一段代码。
func keccakF23Pure(s *[25]uint64) {
	a0, a1, a2, a3, a4 := s[0], s[1], s[2], s[3], s[4]
	a5, a6, a7, a8, a9 := s[5], s[6], s[7], s[8], s[9]
	a10, a11, a12, a13, a14 := s[10], s[11], s[12], s[13], s[14]
	a15, a16, a17, a18, a19 := s[15], s[16], s[17], s[18], s[19]
	a20, a21, a22, a23, a24 := s[20], s[21], s[22], s[23], s[24]

	for r := 1; r < 24; r++ {
		// θ: 列奇偶校验 + 相邻列扩散
		c0 := a0 ^ a5 ^ a10 ^ a15 ^ a20
		c1 := a1 ^ a6 ^ a11 ^ a16 ^ a21
		c2 := a2 ^ a7 ^ a12 ^ a17 ^ a22
		c3 := a3 ^ a8 ^ a13 ^ a18 ^ a23
		c4 := a4 ^ a9 ^ a14 ^ a19 ^ a24
		d0 := c4 ^ rotl64(c1, 1)
		d1 := c0 ^ rotl64(c2, 1)
		d2 := c1 ^ rotl64(c3, 1)
		d3 := c2 ^ rotl64(c4, 1)
		d4 := c3 ^ rotl64(c0, 1)
		a0 ^= d0
		a5 ^= d0
		a10 ^= d0
		a15 ^= d0
		a20 ^= d0
		a1 ^= d1
		a6 ^= d1
		a11 ^= d1
		a16 ^= d1
		a21 ^= d1
		a2 ^= d2
		a7 ^= d2
		a12 ^= d2
		a17 ^= d2
		a22 ^= d2
		a3 ^= d3
		a8 ^= d3
		a13 ^= d3
		a18 ^= d3
		a23 ^= d3
		a4 ^= d4
		a9 ^= d4
		a14 ^= d4
		a19 ^= d4
		a24 ^= d4

		// ρ + π: 每个 lane 旋转固定位数后换位
		b0 := a0
		b10 := rotl64(a1, 1)
		b20 := rotl64(a2, 62)
		b5 := rotl64(a3, 28)
		b15 := rotl64(a4, 27)
		b16 := rotl64(a5, 36)
		b1 := rotl64(a6, 44)
		b11 := rotl64(a7, 6)
		b21 := rotl64(a8, 55)
		b6 := rotl64(a9, 20)
		b7 := rotl64(a10, 3)
		b17 := rotl64(a11, 10)
		b2 := rotl64(a12, 43)
		b12 := rotl64(a13, 25)
		b22 := rotl64(a14, 39)
		b23 := rotl64(a15, 41)
		b8 := rotl64(a16, 45)
		b18 := rotl64(a17, 15)
		b3 := rotl64(a18, 21)
		b13 := rotl64(a19, 8)
		b14 := rotl64(a20, 18)
		b24 := rotl64(a21, 2)
		b9 := rotl64(a22, 61)
		b19 := rotl64(a23, 56)
		b4 := rotl64(a24, 14)

		// χ: 唯一的非线性层
		a0 = b0 ^ (^b1 & b2)
		a1 = b1 ^ (^b2 & b3)
		a2 = b2 ^ (^b3 & b4)
		a3 = b3 ^ (^b4 & b0)
		a4 = b4 ^ (^b0 & b1)
		a5 = b5 ^ (^b6 & b7)
		a6 = b6 ^ (^b7 & b8)
		a7 = b7 ^ (^b8 & b9)
		a8 = b8 ^ (^b9 & b5)
		a9 = b9 ^ (^b5 & b6)
		a10 = b10 ^ (^b11 & b12)
		a11 = b11 ^ (^b12 & b13)
		a12 = b12 ^ (^b13 & b14)
		a13 = b13 ^ (^b14 & b10)
		a14 = b14 ^ (^b10 & b11)
		a15 = b15 ^ (^b16 & b17)
		a16 = b16 ^ (^b17 & b18)
		a17 = b17 ^ (^b18 & b19)
		a18 = b18 ^ (^b19 & b15)
		a19 = b19 ^ (^b15 & b16)
		a20 = b20 ^ (^b21 & b22)
		a21 = b21 ^ (^b22 & b23)
		a22 = b22 ^ (^b23 & b24)
		a23 = b23 ^ (^b24 & b20)
		a24 = b24 ^ (^b20 & b21)

		// ι
		a0 ^= rc[r]
	}

	s[0], s[1], s[2], s[3], s[4] = a0, a1, a2, a3, a4
	s[5], s[6], s[7], s[8], s[9] = a5, a6, a7, a8, a9
	s[10], s[11], s[12], s[13], s[14] = a10, a11, a12, a13, a14
	s[15], s[16], s[17], s[18], s[19] = a15, a16, a17, a18, a19
	s[20], s[21], s[22], s[23], s[24] = a20, a21, a22, a23, a24
}

// DeepSeekHashV1 返回 data 的 32 字节摘要，等价于官方 WASM 的 wasm_deepseek_hash_v1。
//
// 注意：与标准 SHA3-256 的唯一区别是 Keccak-f 少做 round 0，所以不能直接用
// SHA3 库代替；历史上这一实现是逐字节比对官方 WASM 输出验证的。
func DeepSeekHashV1(data []byte) [32]byte {
	var s [25]uint64

	off := 0
	for off+hashRate <= len(data) {
		for i := 0; i < hashRate/8; i++ {
			s[i] ^= binary.LittleEndian.Uint64(data[off+i*8:])
		}
		keccakF23(&s)
		off += hashRate
	}

	var final [hashRate]byte
	copy(final[:], data[off:])
	final[len(data)-off] = 0x06
	final[hashRate-1] |= 0x80
	for i := 0; i < hashRate/8; i++ {
		s[i] ^= binary.LittleEndian.Uint64(final[i*8:])
	}
	keccakF23(&s)

	var out [32]byte
	binary.LittleEndian.PutUint64(out[0:], s[0])
	binary.LittleEndian.PutUint64(out[8:], s[1])
	binary.LittleEndian.PutUint64(out[16:], s[2])
	binary.LittleEndian.PutUint64(out[24:], s[3])
	return out
}
