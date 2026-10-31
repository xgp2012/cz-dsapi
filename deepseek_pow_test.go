package pow

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/rand"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// 测试向量来自直接调用 DeepSeek 官方 WASM（后者是唯一权威实现）。
func TestDeepSeekHashV1(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"", "e594808bc5b7151ac160c6d39a02e0a8e261ed588578403099e3561dc40c26b3"},
		{"testsalt_1700000000_42", "d4a2ea58c89e40887c933484868380c6f803eaa8dc53a3b9df8e431b921a4f09"},
		{"testsalt_1700000000_100000", "abea2f35796b65486e9be1b36f7878c66cab021e96faa473fdf4decd31f9ba30"},
		{"abc123salt_1700000000_12345", "74b3b7452745b70e85eb32ee7f0a9ec0381d42dd5137b695da915e104fc390e1"},
		// 以下三个由独立小工具 /tmp/powgen 生成（同一算法但独立构建），用于钉住回归
		{"testsalt_1700000000_0", "b1f454f08e385082024f1ee8155c11dd1bb9eb772c8102904d7d4e462d0b77ed"},
		{"testsalt_1700000000_1", "bf32487dbdc6ee69f6d4a9bb7c224b8733a66cfd33ef6b9c65e978f42d4dbed0"},
		{"testsalt_1700000000_143999", "71caafc3dddc540beac8e8c885beeaf52558e8cb309b53c2cc312ccb2969d8cf"},
	} {
		h := DeepSeekHashV1([]byte(tc.in))
		got := hex.EncodeToString(h[:])
		if got != tc.want {
			t.Errorf("hash(%q) = %s, want %s", tc.in, got, tc.want)
		}
	}
}

// referenceSolve 是旧版（单线程、每 nonce 重建末块）实现，保留在这里只做交叉验证。
// 任何优化都必须与它逐字节一致。
func referenceSolve(challengeHex, salt string, expireAt, difficulty int64) (int64, error) {
	target, _ := hex.DecodeString(challengeHex)
	var ta [32]byte
	copy(ta[:], target)
	t0 := binary.LittleEndian.Uint64(ta[0:])
	t1 := binary.LittleEndian.Uint64(ta[8:])
	t2 := binary.LittleEndian.Uint64(ta[16:])
	t3 := binary.LittleEndian.Uint64(ta[24:])

	prefix := []byte(BuildPrefix(salt, expireAt))
	const rate = 136
	var baseState [25]uint64
	off := 0
	for off+rate <= len(prefix) {
		for i := 0; i < rate/8; i++ {
			baseState[i] ^= binary.LittleEndian.Uint64(prefix[off+i*8:])
		}
		keccakF23(&baseState)
		off += rate
	}
	tailLen := len(prefix) - off
	var tail [rate]byte
	copy(tail[:], prefix[off:])

	var numBuf [20]byte
	for n := int64(0); n < difficulty; n++ {
		v := uint64(n)
		pos := 20
		if v == 0 {
			pos--
			numBuf[pos] = '0'
		} else {
			for v > 0 {
				pos--
				numBuf[pos] = byte('0' + v%10)
				v /= 10
			}
		}
		numLen := 20 - pos
		s := baseState
		totalTail := tailLen + numLen
		if totalTail < rate {
			var buf [rate]byte
			copy(buf[:tailLen], tail[:tailLen])
			copy(buf[tailLen:totalTail], numBuf[pos:])
			buf[totalTail] = 0x06
			buf[rate-1] |= 0x80
			for i := 0; i < rate/8; i++ {
				s[i] ^= binary.LittleEndian.Uint64(buf[i*8:])
			}
			keccakF23(&s)
		} else {
			var buf [rate]byte
			copy(buf[:tailLen], tail[:tailLen])
			copy(buf[tailLen:rate], numBuf[pos:pos+(rate-tailLen)])
			for i := 0; i < rate/8; i++ {
				s[i] ^= binary.LittleEndian.Uint64(buf[i*8:])
			}
			keccakF23(&s)
			var buf2 [rate]byte
			rem := totalTail - rate
			copy(buf2[:rem], numBuf[pos+(rate-tailLen):pos+(rate-tailLen)+rem])
			buf2[rem] = 0x06
			buf2[rate-1] |= 0x80
			for i := 0; i < rate/8; i++ {
				s[i] ^= binary.LittleEndian.Uint64(buf2[i*8:])
			}
			keccakF23(&s)
		}
		if s[0] == t0 && s[1] == t1 && s[2] == t2 && s[3] == t3 {
			return n, nil
		}
	}
	return 0, errNoSolution
}

var errNoSolution = &noSolutionError{}

type noSolutionError struct{}

func (*noSolutionError) Error() string { return "no solution in reference solve" }

func challengeFor(salt string, expireAt, nonce int64) string {
	prefix := BuildPrefix(salt, expireAt) + strconv.FormatInt(nonce, 10)
	h := DeepSeekHashV1([]byte(prefix))
	return hex.EncodeToString(h[:])
}

func TestSolvePow(t *testing.T) {
	for _, tc := range []struct {
		salt   string
		expire int64
		answer int64
		diff   int64
	}{
		{"testsalt", 1700000000, 0, 1000},
		{"testsalt", 1700000000, 42, 1000},
		{"testsalt", 1700000000, 500, 2000},
		{"abc123salt", 1700000000, 12345, 20000},
		{"testsalt-abc", 1792994013, 140000, 144000},
	} {
		got, err := SolvePow(context.Background(), challengeFor(tc.salt, tc.expire, tc.answer),
			tc.salt, tc.expire, tc.diff)
		if err != nil || got != tc.answer {
			t.Errorf("salt=%q answer=%d: got=%d err=%v", tc.salt, tc.answer, got, err)
		}
	}
}

// TestSolvePowMatchesReference 交叉验证：随机 (salt, expire, nonce) 下并行求解器的
// 结果必须与旧版单线程实现一致（逐字节等价），并覆盖 1/2/4/8 worker 与位数边界。
func TestSolvePowMatchesReference(t *testing.T) {
	rng := rand.New(rand.NewSource(20251030))
	salts := []string{"testsalt", "abc123salt", "testsalt-abc", "x", "0f8a7b6c5d4e3f2a1b0c"}
	for i := 0; i < 24; i++ {
		salt := salts[rng.Intn(len(salts))]
		expire := int64(1700000000 + rng.Intn(10000000))
		diff := int64(1 + rng.Intn(5000))
		answer := rng.Int63n(diff)
		ch := challengeFor(salt, expire, answer)

		want, err := referenceSolve(ch, salt, expire, diff)
		if err != nil {
			t.Fatalf("reference solve failed: %v", err)
		}
		if want != answer {
			t.Fatalf("reference solve returned %d, want %d", want, answer)
		}
		for _, workers := range []int{0, 1, 2, 4, 8, 64} {
			got, err := SolvePowWorkers(context.Background(), ch, salt, expire, diff, workers)
			if err != nil || got != want {
				t.Fatalf("salt=%q expire=%d diff=%d workers=%d: got=%d want=%d err=%v",
					salt, expire, diff, workers, got, want, err)
			}
		}
	}
}

// TestSolvePowLongPrefix 强制走「前缀尾巴 + 数字 ≥ 136 字节」的两块末块路径。
// 只有 tailLen + 位数 ≥ 136 时才会触发；这里选最小的那个位数，保证测试够快。
func TestSolvePowLongPrefix(t *testing.T) {
	base := int64(1700000000)
	for tailLen := 132; tailLen <= 135; tailLen++ {
		// prefix = salt + "_" + expireAt + "_"
		saltLen := tailLen - len(strconv.FormatInt(base, 10)) - 2
		salt := strings.Repeat("s", saltLen)
		if got := len(BuildPrefix(salt, base)); got != tailLen {
			t.Fatalf("prefix len = %d, want %d", got, tailLen)
		}
		d := hashRate - tailLen // 刚好触发两块路径的最小位数
		lo := pow10Sat(d - 1)
		if d == 1 {
			lo = 0
		}
		answer := lo + 7
		diff := lo + 500
		ch := challengeFor(salt, base, answer)
		want, err := referenceSolve(ch, salt, base, diff)
		if err != nil || want != answer {
			t.Fatalf("reference tailLen=%d d=%d: got=%d want=%d err=%v", tailLen, d, want, answer, err)
		}
		for _, workers := range []int{1, 4} {
			got, err := SolvePowWorkers(context.Background(), ch, salt, base, diff, workers)
			if err != nil || got != answer {
				t.Fatalf("tailLen=%d d=%d workers=%d: got=%d want=%d err=%v", tailLen, d, workers, got, answer, err)
			}
		}
	}
}

// TestSolverPlanCoversDigitCounts 直接验证预计算末块 plan：对任意 tailLen / 位数，
// 单 nonce 区间 [n, n+1) 必须能被 searchRange 命中（等价于与 DeepSeekHashV1 逐字节一致）。
// 覆盖 tailLen=0（前缀整块对齐）、单块、两块、1~19 位 nonce，且开销只有 1 次哈希。
func TestSolverPlanCoversDigitCounts(t *testing.T) {
	base := int64(1700000000)
	tailLens := []int{0, 1, 6, 7, 8, 25, 63, 64, 116, 117, 118, 128, 129, 130, 131, 132, 134, 135}
	nonces := []int64{
		0, 1, 9, 10, 99, 100, 999, 1000, 12345, 100000, 143999, 999999,
		1234567, 1_000_000_000, 1_000_000_000_000, 1_000_000_000_000_000,
		1_000_000_000_000_000_005,
	}
	for _, tailLen := range tailLens {
		// 让前缀刚好吸收一个整块，剩下的尾巴长度 = tailLen
		saltLen := tailLen + hashRate - len(strconv.FormatInt(base, 10)) - 2
		salt := strings.Repeat("t", saltLen)
		prefix := BuildPrefix(salt, base)
		if got := len(prefix) % hashRate; got != tailLen {
			t.Fatalf("prefix len %% 136 = %d, want %d", got, tailLen)
		}
		for _, n := range nonces {
			h := DeepSeekHashV1([]byte(prefix + strconv.FormatInt(n, 10)))
			s := newSolver(h[:], salt, base, n+1)
			var done atomic.Bool
			got, ok := s.searchRange(context.Background(), n, n+1, &done)
			if !ok || got != n {
				t.Fatalf("tailLen=%d n=%d: plan search got=%d ok=%v", tailLen, n, got, ok)
			}
		}
	}
}

func TestSolvePowContextCancel(t *testing.T) {
	// 用一个几乎不可能命中的 challenge，保证不会提前返回
	ch := strings.Repeat("00", 32)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := SolvePow(ctx, ch, "testsalt", 1700000000, 1<<40)
	if err == nil {
		t.Fatal("expected context error")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("ctx cancel took too long: %v", elapsed)
	}
}

func TestDefaultWorkers(t *testing.T) {
	t.Setenv("POW_WORKERS", "3")
	if got := DefaultWorkers(); got != 3 {
		t.Fatalf("POW_WORKERS=3 -> %d", got)
	}
	t.Setenv("POW_WORKERS", "not-a-number")
	if got := DefaultWorkers(); got < 1 {
		t.Fatalf("invalid POW_WORKERS -> %d", got)
	}
}

// 确认 solver.searchRange 在 done 已被置位时立刻退出（并行取消路径）。
func TestSearchRangeStopsWhenDone(t *testing.T) {
	ch := challengeFor("testsalt", 1700000000, 0)
	target, _ := hex.DecodeString(ch)
	s := newSolver(target, "testsalt", 1700000000, 1<<30)
	var done atomic.Bool
	done.Store(true)
	start := time.Now()
	if _, ok := s.searchRange(context.Background(), 0, 1<<30, &done); ok {
		t.Fatal("should not find")
	}
	if elapsed := time.Since(start); elapsed > 500*time.Millisecond {
		t.Fatalf("searchRange ignored done flag: %v", elapsed)
	}
}

func TestSolveAndBuildHeader(t *testing.T) {
	t0 := DeepSeekHashV1([]byte("salt_1712345678_777"))
	header, err := SolveAndBuildHeader(context.Background(), &Challenge{
		Algorithm: "DeepSeekHashV1", Challenge: hex.EncodeToString(t0[:]),
		Salt: "salt", ExpireAt: 1712345678, Difficulty: 2000,
		Signature: "sig", TargetPath: "/api/v0/chat/completion",
	})
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := base64.StdEncoding.DecodeString(header)
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	if int64(m["answer"].(float64)) != 777 {
		t.Errorf("answer = %v, want 777", m["answer"])
	}
	if _, ok := m["difficulty"]; ok {
		t.Error("header 不应包含 difficulty")
	}
	if _, ok := m["expire_at"]; ok {
		t.Error("header 不应包含 expire_at")
	}
}

func BenchmarkHash(b *testing.B) {
	d := []byte("realisticsalt_1712345678_12345")
	for i := 0; i < b.N; i++ {
		DeepSeekHashV1(d)
	}
}

func BenchmarkSolve(b *testing.B) {
	h := DeepSeekHashV1([]byte("realisticsalt_1712345678_72000"))
	ch := hex.EncodeToString(h[:])
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _ = SolvePow(context.Background(), ch, "realisticsalt", 1712345678, 144000)
	}
}

func BenchmarkSolveWorkers1(b *testing.B) {
	h := DeepSeekHashV1([]byte("realisticsalt_1712345678_72000"))
	ch := hex.EncodeToString(h[:])
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _ = SolvePowWorkers(context.Background(), ch, "realisticsalt", 1712345678, 144000, 1)
	}
}

// TestKeccakNEONMatchesPure 验证 ARMv8.2 SHA3 汇编置换与纯 Go 实现逐字节一致。
// 不支持的机器上自动 skip；纯 Go 路径由 TestDeepSeekHashV1 的已知向量覆盖。
func TestKeccakNEONMatchesPure(t *testing.T) {
	if !useNEON {
		t.Skip("NEON/SHA3 汇编未启用（非 arm64、无 HWCAP_SHA3 或 POW_NO_NEON=1）")
	}
	rng := rand.New(rand.NewSource(42))
	for i := 0; i < 500; i++ {
		var a, b [25]uint64
		for j := range a {
			a[j] = rng.Uint64()
		}
		b = a
		keccakF23Pure(&a)
		keccakF23NEON(&b)
		if a != b {
			t.Fatalf("NEON 与纯 Go 置换不一致（第 %d 组）:\n%x\n%x", i, a, b)
		}
	}
}

// TestHashBackend 打印/校验当前使用的 Keccak 后端，便于线上排查。
func TestHashBackend(t *testing.T) {
	t.Logf("Keccak 后端: NEON/SHA3=%v (neonAvailable=%v)", useNEON, neonAvailable)
	h := DeepSeekHashV1([]byte("testsalt_1700000000_42"))
	if got := hex.EncodeToString(h[:]); got != "d4a2ea58c89e40887c933484868380c6f803eaa8dc53a3b9df8e431b921a4f09" {
		t.Fatalf("hash mismatch: %s", got)
	}
}

// TestConcurrentSolves 多个 SolvePow 并发跑（各自独立的 solver），确认没有共享可变状态。
// 本机内核跑不了 ThreadSanitizer（39-bit VA），这个测试作为 race 的补充验证：
// 共享的只有只读的 rc 表 / useNEON 和各自 solver 内的预计算数据。
func TestConcurrentSolves(t *testing.T) {
	const n = 6
	type job struct {
		answer int64
		ch     string
	}
	jobs := make([]job, n)
	for i := range jobs {
		answer := int64((i + 1) * 3000)
		jobs[i] = job{answer: answer, ch: challengeFor("concurrent", 1700000000, answer)}
	}
	errs := make(chan error, n)
	for i := range jobs {
		go func(j job) {
			got, err := SolvePow(context.Background(), j.ch, "concurrent", 1700000000, 20000)
			if err != nil {
				errs <- err
				return
			}
			if got != j.answer {
				errs <- fmt.Errorf("answer mismatch: got=%d want=%d", got, j.answer)
				return
			}
			errs <- nil
		}(jobs[i])
	}
	for range jobs {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
}
