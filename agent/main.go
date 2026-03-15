package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const defaultAgentVersion = "0.1.0"

type config struct {
	NodeID        string
	ClaimToken    string
	APIBaseURL    string
	AgentStateDir string
	AgentVersion  string
}

type client struct {
	baseURL    string
	httpClient *http.Client
}

type apiError struct {
	StatusCode int
	Path       string
	Body       string
}

func (e *apiError) Error() string {
	return fmt.Sprintf("request to %s failed with status %d: %s", e.Path, e.StatusCode, e.Body)
}

type registerResponse struct {
	OK              bool   `json:"ok"`
	Registered      bool   `json:"registered"`
	ServerPublicKey string `json:"serverPublicKey"`
}

type challengeResponse struct {
	OK              bool   `json:"ok"`
	Challenge       string `json:"challenge"`
	ServerPublicKey string `json:"serverPublicKey"`
}

type verifyResponse struct {
	OK            bool `json:"ok"`
	Authenticated bool `json:"authenticated"`
}

type agentMeta struct {
	NodeID          string    `json:"nodeId"`
	Registered      bool      `json:"registered"`
	RegisteredAt    time.Time `json:"registeredAt,omitempty"`
	ServerPublicKey string    `json:"serverPublicKey,omitempty"`
}

type state struct {
	dir        string
	privateKey ed25519.PrivateKey
	publicKey  ed25519.PublicKey
	meta       agentMeta
}

type wsEnvelope struct {
	Type            string `json:"type"`
	NodeID          string `json:"nodeId,omitempty"`
	Challenge       string `json:"challenge,omitempty"`
	Signature       string `json:"signature,omitempty"`
	ExecutionID     string `json:"executionId,omitempty"`
	AssignmentID    string `json:"assignmentId,omitempty"`
	Target          string `json:"target,omitempty"`
	CheckType       string `json:"checkType,omitempty"`
	Role            string `json:"role,omitempty"`
	ResultStatus    string `json:"resultStatus,omitempty"`
	LatencyMs       int64  `json:"latencyMs,omitempty"`
	ServerPublicKey string `json:"serverPublicKey,omitempty"`
	Reason          string `json:"reason,omitempty"`
	TS              int64  `json:"ts,omitempty"`
}

type wsSession struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

func (s *wsSession) writeJSON(payload any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conn.WriteJSON(payload)
}

func main() {
	loadDotEnv(".env")

	cfg := config{
		NodeID:        getenv("NODE_ID", ""),
		ClaimToken:    getenv("NODE_CLAIM_TOKEN", ""),
		APIBaseURL:    strings.TrimRight(getenv("API_BASE_URL", "https://api.pulseofmesh.app"), "/"),
		AgentStateDir: getenv("AGENT_STATE_DIR", "./data"),
		AgentVersion:  getenv("AGENT_VERSION", defaultAgentVersion),
	}

	command := "run"
	if len(os.Args) >= 2 {
		command = os.Args[1]
	} else {
		log.Printf("no command provided, defaulting to run")
	}

	st, err := loadOrCreateState(cfg.AgentStateDir)
	if err != nil {
		log.Fatal(err)
	}

	api := &client{
		baseURL: cfg.APIBaseURL,
		httpClient: &http.Client{
			Timeout: 15 * time.Second,
		},
	}

	switch command {
	case "register":
		if err := runRegister(cfg, api, st); err != nil {
			log.Fatal(err)
		}
	case "auth-test":
		if err := runAuthTest(cfg, api, st); err != nil {
			log.Fatal(err)
		}
	case "run":
		if err := runPersistent(cfg, api, st); err != nil {
			log.Fatal(err)
		}
	default:
		log.Fatalf("unknown command %q", command)
	}
}

func runRegister(cfg config, api *client, st *state) error {
	if cfg.NodeID == "" || cfg.ClaimToken == "" {
		return errors.New("NODE_ID and NODE_CLAIM_TOKEN are required")
	}

	hardware, err := collectHardware()
	if err != nil {
		return err
	}

	publicKeyDER, err := x509.MarshalPKIXPublicKey(st.publicKey)
	if err != nil {
		return err
	}

	var response registerResponse
	if err := api.post("/agent/register", map[string]any{
		"nodeId":       cfg.NodeID,
		"claimToken":   cfg.ClaimToken,
		"publicKey":    base64.StdEncoding.EncodeToString(publicKeyDER),
		"agentVersion": cfg.AgentVersion,
		"hardware":     hardware,
	}, &response); err != nil {
		return err
	}

	if !response.OK || !response.Registered {
		return errors.New("registration was not acknowledged by server")
	}

	st.meta.NodeID = cfg.NodeID
	st.meta.Registered = true
	st.meta.RegisteredAt = time.Now().UTC()

	if response.ServerPublicKey != "" {
		st.meta.ServerPublicKey = response.ServerPublicKey
		if err := writeFile(filepath.Join(cfg.AgentStateDir, "server_public_key.txt"), []byte(response.ServerPublicKey), 0o600); err != nil {
			return err
		}
	}

	if err := st.saveMeta(); err != nil {
		return err
	}

	log.Printf("registration completed nodeId=%s", cfg.NodeID)
	return nil
}

func runAuthTest(cfg config, api *client, st *state) error {
	if cfg.NodeID == "" {
		return errors.New("NODE_ID is required")
	}

	var challenge challengeResponse
	if err := api.post("/agent/auth/challenge", map[string]any{
		"nodeId": cfg.NodeID,
	}, &challenge); err != nil {
		return err
	}

	signature := ed25519.Sign(st.privateKey, []byte(challenge.Challenge))

	var verify verifyResponse
	if err := api.post("/agent/auth/verify", map[string]any{
		"nodeId":    cfg.NodeID,
		"signature": base64.StdEncoding.EncodeToString(signature),
	}, &verify); err != nil {
		return err
	}

	if !verify.OK || !verify.Authenticated {
		return errors.New("authentication was not accepted by server")
	}

	if challenge.ServerPublicKey != "" {
		if err := st.storeServerPublicKey(challenge.ServerPublicKey); err != nil {
			return err
		}
	}

	log.Printf("auth success nodeId=%s", cfg.NodeID)
	return nil
}

func runPersistent(cfg config, api *client, st *state) error {
	if cfg.NodeID == "" {
		return errors.New("NODE_ID is required")
	}

	if err := ensureRegistered(cfg, api, st); err != nil {
		return err
	}

	backoff := 3 * time.Second

	for {
		if err := connectAndServe(cfg, st); err != nil {
			log.Printf("agent session ended: %v", err)
		}

		log.Printf("reconnect scheduled in=%s", backoff)
		time.Sleep(backoff)

		if backoff < 30*time.Second {
			backoff *= 2
			if backoff > 30*time.Second {
				backoff = 30 * time.Second
			}
		}
	}
}

func ensureRegistered(cfg config, api *client, st *state) error {
	if st.meta.Registered && st.meta.NodeID == cfg.NodeID {
		log.Printf("registration skipped nodeId=%s", cfg.NodeID)
		return nil
	}

	err := runRegister(cfg, api, st)
	if err == nil {
		return nil
	}

	var httpErr *apiError
	if errors.As(err, &httpErr) && httpErr.StatusCode == http.StatusConflict {
		log.Printf("registration skipped nodeId=%s", cfg.NodeID)
		st.meta.NodeID = cfg.NodeID
		st.meta.Registered = true
		if saveErr := st.saveMeta(); saveErr != nil {
			return saveErr
		}
		return nil
	}

	return err
}

func connectAndServe(cfg config, st *state) error {
	wsURL, err := websocketURL(cfg.APIBaseURL)
	if err != nil {
		return err
	}

	dialer := websocket.Dialer{
		HandshakeTimeout: 15 * time.Second,
	}

	conn, response, err := dialer.Dial(wsURL, nil)
	if err != nil {
		if response != nil {
			return fmt.Errorf("websocket dial failed with status %s", response.Status)
		}
		return err
	}
	defer conn.Close()

	session := &wsSession{conn: conn}
	log.Printf("websocket connected url=%s", wsURL)

	if err := session.writeJSON(wsEnvelope{
		Type:   "hello",
		NodeID: cfg.NodeID,
	}); err != nil {
		return err
	}

	authenticated, err := completeWSAuth(session, cfg, st)
	if err != nil {
		return err
	}
	if !authenticated {
		return errors.New("websocket authentication was not accepted")
	}

	log.Printf("auth success nodeId=%s", cfg.NodeID)

	stopHeartbeat := make(chan struct{})
	heartbeatErr := make(chan error, 1)

	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-ticker.C:
				if err := session.writeJSON(wsEnvelope{
					Type:   "heartbeat",
					NodeID: cfg.NodeID,
					TS:     time.Now().Unix(),
				}); err != nil {
					heartbeatErr <- err
					return
				}
				log.Printf("heartbeat sent nodeId=%s", cfg.NodeID)
			case <-stopHeartbeat:
				return
			}
		}
	}()

	for {
		select {
		case err := <-heartbeatErr:
			close(stopHeartbeat)
			return err
		default:
		}

		var message wsEnvelope
		if err := conn.ReadJSON(&message); err != nil {
			close(stopHeartbeat)
			return err
		}

		switch message.Type {
		case "heartbeat_ack":
			log.Printf("heartbeat acknowledged for node %s", cfg.NodeID)
		case "assignment":
			go handleAssignment(session, cfg, message)
		case "challenge":
			log.Printf("received unexpected challenge after auth for node %s", cfg.NodeID)
		case "auth_error":
			close(stopHeartbeat)
			return fmt.Errorf("server rejected authenticated session: %s", message.Reason)
		default:
			log.Printf("received message type %q", message.Type)
		}
	}
}

func handleAssignment(session *wsSession, cfg config, message wsEnvelope) {
	if message.AssignmentID == "" || message.Target == "" || message.CheckType == "" {
		log.Printf("received invalid assignment payload nodeId=%s", cfg.NodeID)
		return
	}

	log.Printf(
		"assignment received nodeId=%s executionId=%s assignmentId=%s target=%s checkType=%s role=%s",
		cfg.NodeID,
		emptyIfMissing(message.ExecutionID),
		message.AssignmentID,
		message.Target,
		message.CheckType,
		message.Role,
	)

	if err := session.writeJSON(wsEnvelope{
		Type:         "assignment_ack",
		NodeID:       cfg.NodeID,
		ExecutionID:  message.ExecutionID,
		AssignmentID: message.AssignmentID,
	}); err != nil {
		log.Printf("failed to send assignment ack nodeId=%s assignmentId=%s err=%v", cfg.NodeID, message.AssignmentID, err)
		return
	}

	resultStatus, latencyMs := executeTCPCheck(message.Target, 5*time.Second)
	if err := session.writeJSON(wsEnvelope{
		Type:         "result",
		NodeID:       cfg.NodeID,
		ExecutionID:  message.ExecutionID,
		AssignmentID: message.AssignmentID,
		ResultStatus: resultStatus,
		LatencyMs:    latencyMs,
	}); err != nil {
		log.Printf("failed to send result nodeId=%s assignmentId=%s err=%v", cfg.NodeID, message.AssignmentID, err)
		return
	}

	log.Printf(
		"result sent nodeId=%s assignmentId=%s resultStatus=%s latencyMs=%d",
		cfg.NodeID,
		message.AssignmentID,
		resultStatus,
		latencyMs,
	)
}

func emptyIfMissing(value string) string {
	if value == "" {
		return "n/a"
	}

	return value
}

func executeTCPCheck(target string, timeout time.Duration) (string, int64) {
	startedAt := time.Now()
	conn, err := net.DialTimeout("tcp", target, timeout)
	if err != nil {
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			return "timeout", 0
		}
		return "error", 0
	}
	defer conn.Close()

	return "up", time.Since(startedAt).Milliseconds()
}

func completeWSAuth(session *wsSession, cfg config, st *state) (bool, error) {
	var first wsEnvelope
	if err := session.conn.ReadJSON(&first); err != nil {
		return false, err
	}

	if first.Type != "challenge" {
		if first.Type == "auth_error" {
			return false, fmt.Errorf("server rejected hello: %s", first.Reason)
		}
		return false, fmt.Errorf("expected challenge, got %q", first.Type)
	}

	log.Printf("challenge received nodeId=%s", cfg.NodeID)

	if first.ServerPublicKey != "" {
		if err := st.storeServerPublicKey(first.ServerPublicKey); err != nil {
			return false, err
		}
	}

	signature := ed25519.Sign(st.privateKey, []byte(first.Challenge))
	if err := session.writeJSON(wsEnvelope{
		Type:      "auth",
		NodeID:    cfg.NodeID,
		Signature: base64.StdEncoding.EncodeToString(signature),
	}); err != nil {
		return false, err
	}

	var second wsEnvelope
	if err := session.conn.ReadJSON(&second); err != nil {
		return false, err
	}

	switch second.Type {
	case "auth_ok":
		return true, nil
	case "auth_error":
		return false, fmt.Errorf("auth failed: %s", second.Reason)
	default:
		return false, fmt.Errorf("expected auth response, got %q", second.Type)
	}
}

func websocketURL(apiBaseURL string) (string, error) {
	parsed, err := url.Parse(apiBaseURL)
	if err != nil {
		return "", err
	}

	switch parsed.Scheme {
	case "https":
		parsed.Scheme = "wss"
	case "http":
		parsed.Scheme = "ws"
	default:
		return "", fmt.Errorf("unsupported API base URL scheme %q", parsed.Scheme)
	}

	parsed.Path = "/agent/ws"
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String(), nil
}

func loadOrCreateState(dir string) (*state, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}

	privateKeyPath := filepath.Join(dir, "agent_private_key.pem")
	publicKeyPath := filepath.Join(dir, "agent_public_key.pem")
	metaPath := filepath.Join(dir, "agent_meta.json")

	st := &state{
		dir:  dir,
		meta: loadMeta(metaPath),
	}

	if _, err := os.Stat(privateKeyPath); errors.Is(err, os.ErrNotExist) {
		publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return nil, err
		}

		privateDER, err := x509.MarshalPKCS8PrivateKey(privateKey)
		if err != nil {
			return nil, err
		}

		publicDER, err := x509.MarshalPKIXPublicKey(publicKey)
		if err != nil {
			return nil, err
		}

		if err := writePEM(privateKeyPath, "PRIVATE KEY", privateDER, 0o600); err != nil {
			return nil, err
		}
		if err := writePEM(publicKeyPath, "PUBLIC KEY", publicDER, 0o644); err != nil {
			return nil, err
		}

		st.privateKey = privateKey
		st.publicKey = publicKey
		log.Printf("keypair ready stateDir=%s", dir)
		return st, nil
	}

	privateDER, err := readPEM(privateKeyPath)
	if err != nil {
		return nil, err
	}

	publicDER, err := readPEM(publicKeyPath)
	if err != nil {
		return nil, err
	}

	privateKeyAny, err := x509.ParsePKCS8PrivateKey(privateDER)
	if err != nil {
		return nil, err
	}

	publicKeyAny, err := x509.ParsePKIXPublicKey(publicDER)
	if err != nil {
		return nil, err
	}

	privateKey, ok := privateKeyAny.(ed25519.PrivateKey)
	if !ok {
		return nil, errors.New("stored private key is not ed25519")
	}

	publicKey, ok := publicKeyAny.(ed25519.PublicKey)
	if !ok {
		return nil, errors.New("stored public key is not ed25519")
	}

	st.privateKey = privateKey
	st.publicKey = publicKey
	log.Printf("keypair ready stateDir=%s", dir)
	return st, nil
}

func loadMeta(path string) agentMeta {
	data, err := os.ReadFile(path)
	if err != nil {
		return agentMeta{}
	}

	var meta agentMeta
	if err := json.Unmarshal(data, &meta); err != nil {
		return agentMeta{}
	}

	return meta
}

func (s *state) saveMeta() error {
	data, err := json.MarshalIndent(s.meta, "", "  ")
	if err != nil {
		return err
	}

	return writeFile(filepath.Join(s.dir, "agent_meta.json"), data, 0o600)
}

func (s *state) storeServerPublicKey(publicKey string) error {
	s.meta.ServerPublicKey = publicKey
	if err := writeFile(filepath.Join(s.dir, "server_public_key.txt"), []byte(publicKey), 0o600); err != nil {
		return err
	}
	return s.saveMeta()
}

func collectHardware() (map[string]any, error) {
	hostname, _ := os.Hostname()

	return map[string]any{
		"hostname":  hostname,
		"os":        runtime.GOOS,
		"arch":      runtime.GOARCH,
		"cpuModel":  collectCPUModel(),
		"cpuCores":  runtime.NumCPU(),
		"memoryMB":  collectTotalMemoryMB(),
		"machineId": collectMachineID(),
	}, nil
}

func collectCPUModel() string {
	switch runtime.GOOS {
	case "linux":
		return readFirstMatchingValue("/proc/cpuinfo", "model name")
	case "windows":
		return strings.TrimSpace(os.Getenv("PROCESSOR_IDENTIFIER"))
	default:
		return ""
	}
}

func collectTotalMemoryMB() int {
	if runtime.GOOS == "linux" {
		return readMemTotalMB("/proc/meminfo")
	}
	return 0
}

func collectMachineID() string {
	switch runtime.GOOS {
	case "linux":
		return strings.TrimSpace(firstExistingFile("/etc/machine-id", "/var/lib/dbus/machine-id"))
	default:
		return ""
	}
}

func (c *client) post(path string, payload any, out any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	request, err := http.NewRequest(http.MethodPost, c.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return err
	}

	request.Header.Set("Content-Type", "application/json")

	response, err := c.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()

	responseBody, err := io.ReadAll(response.Body)
	if err != nil {
		return err
	}

	if response.StatusCode >= 400 {
		return &apiError{
			StatusCode: response.StatusCode,
			Path:       path,
			Body:       strings.TrimSpace(string(responseBody)),
		}
	}

	if out == nil {
		return nil
	}

	return json.Unmarshal(responseBody, out)
}

func loadDotEnv(path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}

	for _, rawLine := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}

		key := strings.TrimSpace(parts[0])
		value := strings.Trim(strings.TrimSpace(parts[1]), `"'`)

		if os.Getenv(key) == "" {
			_ = os.Setenv(key, value)
		}
	}
}

func getenv(key, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}

func writePEM(path, blockType string, der []byte, mode os.FileMode) error {
	block := &pem.Block{Type: blockType, Bytes: der}
	return writeFile(path, pem.EncodeToMemory(block), mode)
}

func readPEM(path string) ([]byte, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	block, _ := pem.Decode(data)
	if block == nil {
		return nil, fmt.Errorf("failed to decode PEM file %s", path)
	}

	return block.Bytes, nil
}

func writeFile(path string, data []byte, mode os.FileMode) error {
	if err := os.WriteFile(path, data, mode); err != nil {
		return err
	}
	return os.Chmod(path, mode)
}

func readFirstMatchingValue(path, prefix string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}

	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, prefix) {
			parts := strings.SplitN(line, ":", 2)
			if len(parts) == 2 {
				return strings.TrimSpace(parts[1])
			}
		}
	}

	return ""
}

func readMemTotalMB(path string) int {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0
	}

	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "MemTotal:") {
			fields := strings.Fields(line)
			if len(fields) < 2 {
				return 0
			}

			kb, err := strconv.Atoi(fields[1])
			if err != nil {
				return 0
			}

			return kb / 1024
		}
	}

	return 0
}

func firstExistingFile(paths ...string) string {
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err == nil {
			return string(data)
		}
	}

	return ""
}
