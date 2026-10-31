package pow

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"os"
	"runtime"
	"strconv"
	"sync"
	"sync/atomic"
)

const (
	// defaultDifficulty 是服务端未给 difficulty 时的兜底值。
	defaultDifficulty int64 = 144000
	// cancelCheckMask：每 1024 个 nonce 检查一次 ctx / 其他 worker 是否已命中。
	cancelCheckMask int64 = 0x3FF
	// maxDigits：int64 十进制最多 19 位。
	maxDigits = 19
)

// Challenge 对应 /api/v0/chat/create_pow_challenge 返回的 data.biz_data.challenge。
type Challenge struct {
	Algorithm  string `json:"algorithm"`
	Challenge  string `json:"challenge"`
	Salt       string `json:"salt"`
	ExpireAt   int64  `json:"expire_at"`
	Difficulty int64  `json:"difficulty"`
	Signature  string `json:"signature"`
	TargetPath string `json:"target_path"`
}

// BuildPrefix 返回 nonce 之前的前缀："<salt>_<expire_at>_"。
func BuildPrefix(salt string, expireAt int64) string {
	return salt + "_" + strconv.FormatInt(expireAt, 10) + "_"
}

/* -------------------------------------------------------------------------- *
 * 求解器预计算
 *
 * DeepSeekHashV1(prefix + str(nonce))：前缀固定，所以前缀的整块吸收结果对所有
 * nonce 都相同，只需算一次；每个 nonce 真正变化的只有末尾那一个块里的十进制数字。
 * 于是按「nonce 的十进制位数 d」预计算：
 *   - 末块里数字以外的字节（前缀尾巴、0x06 padding、0x80）预先 XOR 进状态；
 *   - 数字字节先按全 '0' 的模板算进状态，循环里每个 nonce 只补一个 delta
 *     （ASCII '0'..'9' XOR '0' 正好等于数字值 0..9，所以 delta 就是逐位数字）。
 * 典型前缀（tailLen=25 左右）下每个 nonce 只改 1 个 uint64，而不是重建 136 字节块。
 * -------------------------------------------------------------------------- */

// digitBlockPlan 是「nonce 有 d 位十进制」时的末块预计算结果。
type digitBlockPlan struct {
	lo, hi int64 // nonce 区间 [lo, hi)
	digits int   // 十进制位数 d
	single bool  // 末块是否只有一个（tailLen+d < 136）

	state [25]uint64 // 数字按 '0' 填充时，吸收末块后的状态（single）

	split int        // 两块：第一块里容纳的数字个数（=136-tailLen）
	tpl2  [25]uint64 // 两块：第二块（数字按 '0'）的 XOR 模板
}

// solver 是与具体 nonce 无关的预计算数据，可被多个 worker 只读共享。
type solver struct {
	target  [4]uint64 // 目标摘要的前 32 字节，按小端拆成 4 个 word
	tailLen int
	plans   []digitBlockPlan
}

// newSolver 吸收固定前缀，并为 [0, difficulty) 涉及的每个位数预先算好末块状态。
func newSolver(target []byte, salt string, expireAt, difficulty int64) *solver {
	s := &solver{}

	var ta [32]byte
	copy(ta[:], target)
	s.target[0] = binary.LittleEndian.Uint64(ta[0:])
	s.target[1] = binary.LittleEndian.Uint64(ta[8:])
	s.target[2] = binary.LittleEndian.Uint64(ta[16:])
	s.target[3] = binary.LittleEndian.Uint64(ta[24:])

	// 前缀里完整的 136 字节块直接吸收。
	prefix := []byte(BuildPrefix(salt, expireAt))
	var base [25]uint64
	off := 0
	for off+hashRate <= len(prefix) {
		for i := 0; i < hashRate/8; i++ {
			base[i] ^= binary.LittleEndian.Uint64(prefix[off+i*8:])
		}
		keccakF23(&base)
		off += hashRate
	}
	tail := prefix[off:]
	s.tailLen = len(tail)

	// 按 nonce 的十进制位数切区间（0 单独算 1 位）。
	for d := 1; d <= maxDigits; d++ {
		hi := pow10Sat(d)
		if hi > difficulty {
			hi = difficulty
		}
		lo := pow10Sat(d - 1)
		if d == 1 {
			lo = 0
		}
		if lo >= difficulty {
			break
		}
		plan := digitBlockPlan{lo: lo, hi: hi, digits: d}
		if s.tailLen+d < hashRate {
			// 单块路径：末块 = 前缀尾巴 + d 位数字 + 0x06 + ... + 0x80
			var tpl [hashRate]byte
			copy(tpl[:], tail)
			for i := 0; i < d; i++ {
				tpl[s.tailLen+i] = '0'
			}
			tpl[s.tailLen+d] = 0x06
			tpl[hashRate-1] |= 0x80
			plan.single = true
			plan.state = base
			for i := 0; i < hashRate/8; i++ {
				plan.state[i] ^= binary.LittleEndian.Uint64(tpl[i*8:])
			}
		} else {
			// 两块路径（前缀尾巴很长时）：第一块吃掉 tailLen 字节 + split 个数字，
			// 第二块放剩余数字 + 0x06/0x80 再置换一次。正常 salt 不会走到这里。
			split := hashRate - s.tailLen
			plan.split = split
			var tpl1 [hashRate]byte
			copy(tpl1[:], tail)
			for i := 0; i < split; i++ {
				tpl1[s.tailLen+i] = '0'
			}
			plan.state = base
			for i := 0; i < hashRate/8; i++ {
				plan.state[i] ^= binary.LittleEndian.Uint64(tpl1[i*8:])
			}
			rem := d - split
			var tpl2 [hashRate]byte
			for i := 0; i < rem; i++ {
				tpl2[i] = '0'
			}
			tpl2[rem] = 0x06
			tpl2[hashRate-1] |= 0x80
			for i := 0; i < hashRate/8; i++ {
				plan.tpl2[i] = binary.LittleEndian.Uint64(tpl2[i*8:])
			}
		}
		s.plans = append(s.plans, plan)
	}
	return s
}

// pow10Sat 返回 10^d，溢出时饱和到 math.MaxInt64（d>=19）。
func pow10Sat(d int) int64 {
	v := int64(1)
	for i := 0; i < d; i++ {
		if v > math.MaxInt64/10 {
			return math.MaxInt64
		}
		v *= 10
	}
	return v
}

// searchRange 在 [lo, hi) 连续区间里线性搜索答案；命中返回 (nonce, true)。
// done 由其它 worker 共享，一旦命中会被置位，本 worker 尽快退出。
func (s *solver) searchRange(ctx context.Context, lo, hi int64, done *atomic.Bool) (int64, bool) {
	for pi := range s.plans {
		p := &s.plans[pi]
		// 只处理与本区间有交集的部分
		start, end := p.lo, p.hi
		if start < lo {
			start = lo
		}
		if end > hi {
			end = hi
		}
		if start >= end {
			continue
		}
		if p.single {
			if n, ok := s.searchSingle(ctx, p, start, end, done); ok {
				return n, true
			}
		} else {
			if n, ok := s.searchDouble(ctx, p, start, end, done); ok {
				return n, true
			}
		}
	}
	return 0, false
}

// searchSingle 是单块末块的快路径：每个 nonce 只把数字 delta XOR 进 1~2 个 word。
func (s *solver) searchSingle(ctx context.Context, p *digitBlockPlan, lo, hi int64, done *atomic.Bool) (int64, bool) {
	t0, t1, t2, t3 := s.target[0], s.target[1], s.target[2], s.target[3]
	tailLen := s.tailLen
	d := p.digits
	for n := lo; n < hi; n++ {
		if n&cancelCheckMask == 0 {
			if done.Load() {
				return 0, false
			}
			if err := ctx.Err(); err != nil {
				return 0, false
			}
		}
		var st [25]uint64 = p.state
		v := uint64(n)
		for i := d - 1; i >= 0; i-- {
			pos := tailLen + i
			st[pos>>3] ^= (v % 10) << uint((pos&7)*8)
			v /= 10
		}
		keccakF23(&st)
		// 先比 s[0]：绝大多数 nonce 在这里就被排除。
		if st[0] == t0 && st[1] == t1 && st[2] == t2 && st[3] == t3 {
			return n, true
		}
	}
	return 0, false
}

// searchDouble 是两块末块的兜底路径（仅前缀尾巴 ≥ 117 字节时才会用到）。
func (s *solver) searchDouble(ctx context.Context, p *digitBlockPlan, lo, hi int64, done *atomic.Bool) (int64, bool) {
	t0, t1, t2, t3 := s.target[0], s.target[1], s.target[2], s.target[3]
	tailLen := s.tailLen
	d := p.digits
	split := p.split
	for n := lo; n < hi; n++ {
		if n&cancelCheckMask == 0 {
			if done.Load() {
				return 0, false
			}
			if err := ctx.Err(); err != nil {
				return 0, false
			}
		}
		var dbuf [maxDigits]byte
		v := uint64(n)
		for i := d - 1; i >= 0; i-- {
			dbuf[i] = byte(v % 10)
			v /= 10
		}

		// 第一块：前缀尾巴 + 前 split 个数字（数字按 '0' 模板，XOR 数字值即 delta）
		var st [25]uint64 = p.state
		for i := 0; i < split; i++ {
			pos := tailLen + i
			st[pos>>3] ^= uint64(dbuf[i]) << uint((pos&7)*8)
		}
		keccakF23(&st)

		// 第二块：剩余数字 + 0x06 + 0x80
		var st2 [25]uint64 = st
		rem := d - split
		for i := 0; i < hashRate/8; i++ {
			st2[i] ^= p.tpl2[i]
		}
		for i := 0; i < rem; i++ {
			st2[i>>3] ^= uint64(dbuf[split+i]) << uint((i&7)*8)
		}
		keccakF23(&st2)
		if st2[0] == t0 && st2[1] == t1 && st2[2] == t2 && st2[3] == t3 {
			return n, true
		}
	}
	return 0, false
}

/* -------------------------------------------------------------------------- *
 * 预热 / 并行搜索
 * -------------------------------------------------------------------------- */

// Warmup 在开始服务前跑一小段 Keccak，把代码页、分支预测器和 CPU 频率预热。
// powd 启动时调用：常驻进程第一次求解会因冷启动多花几毫秒，预热能把这段
// 开销挪到启动阶段（启动本身已在 server 的 warmUp 路径上，不影响用户请求）。
func Warmup(iterations int) {
	if iterations <= 0 {
		iterations = 4096
	}
	var s [25]uint64
	for i := range s {
		s[i] = uint64(i) * 0x9E3779B97F4A7C15
	}
	for i := 0; i < iterations; i++ {
		keccakF23(&s)
	}
}

// DefaultWorkers 返回默认并行度：POW_WORKERS 环境变量（正整数）优先，否则 NumCPU。
//
// POW_WORKERS 主要用于压测/对比（例如 POW_WORKERS=1 得到单核基线），
// 正常部署不需要设置。
func DefaultWorkers() int {
	workers := runtime.NumCPU()
	if v := os.Getenv("POW_WORKERS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			workers = n
		}
	}
	if workers < 1 {
		workers = 1
	}
	return workers
}

// SolvePow 在 [0, difficulty) 内搜索 nonce 使 DeepSeekHashV1(prefix+str(nonce)) 等于 challenge。
// 并行度取 DefaultWorkers()；需要显式控制时用 SolvePowWorkers。
func SolvePow(ctx context.Context, challengeHex, salt string, expireAt, difficulty int64) (int64, error) {
	return SolvePowWorkers(ctx, challengeHex, salt, expireAt, difficulty, 0)
}

// SolvePowWorkers 与 SolvePow 相同，但可指定并行 worker 数（<=0 表示用 DefaultWorkers()）。
//
// 搜索空间 [0, difficulty) 按连续区间切给 N 个 worker；任意 worker 命中后通过
// 共享 done 标记取消其余 worker（每个 worker 每 1024 个 nonce 检查一次）。
// ctx 取消同样能及时退出（返回 ctx.Err()）。
func SolvePowWorkers(ctx context.Context, challengeHex, salt string, expireAt, difficulty int64, workers int) (int64, error) {
	if len(challengeHex) != 64 {
		return 0, errors.New("pow: challenge must be 64 hex chars")
	}
	target, err := hex.DecodeString(challengeHex)
	if err != nil {
		return 0, err
	}
	if difficulty <= 0 {
		return 0, errors.New("pow: difficulty must be positive")
	}

	s := newSolver(target, salt, expireAt, difficulty)

	if workers <= 0 {
		workers = DefaultWorkers()
	}
	if int64(workers) > difficulty {
		workers = int(difficulty)
	}
	if workers < 1 {
		workers = 1
	}

	var done atomic.Bool
	found := make(chan int64, 1)
	var wg sync.WaitGroup

	chunk := difficulty / int64(workers)
	extra := difficulty % int64(workers)
	lo := int64(0)
	for w := 0; w < workers; w++ {
		size := chunk
		if int64(w) < extra {
			size++
		}
		hi := lo + size
		wg.Add(1)
		go func(lo, hi int64) {
			defer wg.Done()
			if n, ok := s.searchRange(ctx, lo, hi, &done); ok {
				select {
				case found <- n: // 第一个命中的 worker 决定答案
				default:
				}
				done.Store(true)
			}
		}(lo, hi)
		lo = hi
	}
	wg.Wait()

	select {
	case n := <-found:
		return n, nil
	default:
	}
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	return 0, errors.New("pow: no solution within difficulty")
}

/* -------------------------------------------------------------------------- *
 * header 组装
 * -------------------------------------------------------------------------- */

// BuildPowHeader 序列化 {algorithm,challenge,salt,answer,signature,target_path} 为 base64(JSON)。
// 注意：不含 difficulty / expire_at，与服务端期望一致。
func BuildPowHeader(c *Challenge, answer int64) (string, error) {
	b, err := json.Marshal(map[string]any{
		"algorithm": c.Algorithm, "challenge": c.Challenge, "salt": c.Salt,
		"answer": answer, "signature": c.Signature, "target_path": c.TargetPath,
	})
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(b), nil
}

// SolveAndBuildHeader 端到端：Challenge → x-ds-pow-response header string。
func SolveAndBuildHeader(ctx context.Context, c *Challenge) (string, error) {
	if c.Algorithm != "DeepSeekHashV1" {
		return "", errors.New("pow: unsupported algorithm: " + c.Algorithm)
	}
	d := c.Difficulty
	if d == 0 {
		d = defaultDifficulty
	}
	answer, err := SolvePow(ctx, c.Challenge, c.Salt, c.ExpireAt, d)
	if err != nil {
		return "", err
	}
	return BuildPowHeader(c, answer)
}
