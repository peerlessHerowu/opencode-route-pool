package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"opencode2api/internal/httpx"
	"os"
	"strings"
	"time"
)

func main() {
	var captured struct {
		Headers       map[string]string `json:"headers"`
		Body          string            `json:"body"`
		Authorization string            `json:"authorization"`
	}
	traceOnly := len(os.Args) > 1 && os.Args[1] == "--trace"
	if !traceOnly {
		b, e := os.ReadFile(os.Args[1])
		if e != nil {
			panic(e)
		}
		if e = json.Unmarshal(b, &captured); e != nil {
			panic(e)
		}
	}
	proxyURL := "http://127.0.0.1:7897"
	if traceOnly && len(os.Args) > 2 { proxyURL = os.Args[2] }
	proxy, _ := url.Parse(proxyURL)
	t, e := httpx.NewBunTransport(httpx.BunOptions{Proxy: proxy, ConnectTimeout: 8 * time.Second, ResponseHeaderTimeout: 18 * time.Second, IdleConnTimeout: 30 * time.Second, MaxIdleConnsPerHost: 1})
	if e != nil {
		panic(e)
	}
	defer t.CloseIdleConnections()
	c := &http.Client{Transport: t, Timeout: 25 * time.Second}
	records := []map[string]any{}
	steps := []string{"trace-before", "inference", "trace-after"}
	if traceOnly {
		steps = []string{"trace-before"}
	}
	for _, step := range steps {
		u := "https://opencode.ai/cdn-cgi/trace"
		method := "GET"
		body := ""
		if step == "inference" {
			u = "https://opencode.ai/inference/openai/v1/chat/completions"
			method = "POST"
			body = captured.Body
		}
		rec := map[string]any{"step": step}
		connections := []map[string]any{}
		trace := &httptrace.ClientTrace{GotConn: func(i httptrace.GotConnInfo) {
			connections = append(connections, map[string]any{"connection": fmt.Sprintf("%p", i.Conn), "local": i.Conn.LocalAddr().String(), "remote": i.Conn.RemoteAddr().String(), "reused": i.Reused})
		}}
		req, _ := http.NewRequestWithContext(httptrace.WithClientTrace(context.Background(), trace), method, u, bytes.NewBufferString(body))
		if step == "inference" {
			for k, v := range captured.Headers {
				switch strings.ToLower(k) {
				case "host", "content-length", "connection", "accept-encoding":
					continue
				}
				req.Header.Set(k, v)
			}
			if captured.Authorization == "public" {
				req.Header.Set("Authorization", "Bearer public")
			}
		}
		started := time.Now()
		r, err := c.Do(req)
		rec["connections"] = connections
		rec["ms"] = time.Since(started).Milliseconds()
		if err != nil {
			rec["error"] = err.Error()
		} else {
			data, err := io.ReadAll(io.LimitReader(r.Body, 200000))
			r.Body.Close()
			rec["http"] = r.StatusCode
			rec["date"] = r.Header.Get("Date")
			rec["cf_ray"] = r.Header.Get("Cf-Ray")
			rec["retry_after"] = r.Header.Get("Retry-After")
			rec["body"] = string(data)
			if err != nil {
				rec["read_error"] = err.Error()
			}
		}
		records = append(records, rec)
	}
	json.NewEncoder(os.Stdout).Encode(records)
}
