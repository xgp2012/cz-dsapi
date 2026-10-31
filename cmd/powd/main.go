// powd: 常驻的 PoW 求解器，stdin/stdout 逐行 JSON 协议。
//
// 请求: {"id":1,"challenge":"<hex>","salt":"...","expireAt":1792994013,"difficulty":144000}
// 响应: {"id":1,"answer":12345,"ms":9}
// 错误: {"id":1,"error":"..."}
//
// 求解在 [0, difficulty) 上多核并行（默认 runtime.NumCPU() 个 worker，
// 可用 POW_WORKERS 环境变量覆盖，POW_NO_NEON=1 可关掉 ARMv8.2 SHA3 汇编回退纯 Go）。
// 协议本身不变：每行一个 JSON 请求，每行一个 JSON 响应。
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"log"
	"os"
	"time"

	pow "deepseek-web-api"
)

type request struct {
	ID         int    `json:"id"`
	Challenge  string `json:"challenge"`
	Salt       string `json:"salt"`
	ExpireAt   int64  `json:"expireAt"`
	Difficulty int64  `json:"difficulty"`
}

type response struct {
	ID int `json:"id"`
	// answer 不能加 omitempty：answer=0 是合法解（概率 1/difficulty），
	// 省略字段会让 Node 侧把 header 里的 answer 写成 undefined 而被服务端拒收。
	Answer int64  `json:"answer"`
	MS     int64  `json:"ms,omitempty"`
	Error  string `json:"error,omitempty"`
}

func main() {
	// 冷启动预热：把 Keccak 代码页/CPU 频率预热好，避免第一条请求多花几毫秒。
	pow.Warmup(4096)

	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	enc := json.NewEncoder(out)

	for in.Scan() {
		line := in.Bytes()
		if len(line) == 0 {
			continue
		}
		var req request
		if err := json.Unmarshal(line, &req); err != nil {
			_ = enc.Encode(response{Error: err.Error()})
			continue
		}
		if req.Difficulty <= 0 {
			req.Difficulty = 144000
		}
		start := time.Now()
		answer, err := pow.SolvePow(context.Background(), req.Challenge, req.Salt, req.ExpireAt, req.Difficulty)
		resp := response{ID: req.ID, MS: time.Since(start).Milliseconds()}
		if err != nil {
			resp.Error = err.Error()
		} else {
			resp.Answer = answer
		}
		if err := enc.Encode(resp); err != nil {
			log.Println("encode:", err)
			return
		}
		_ = out.Flush()
	}
}
