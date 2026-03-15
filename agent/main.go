package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const agentVersion = "0.1.0"

type config struct {
	NodeID        string
	ClaimToken    string
	APIBaseURL    string
	AgentStateDir string
}

type client struct {
	baseURL    string
	httpClient *http.Client
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

type state struct {
	privateKey ed25519.PrivateKey
	publicKey  ed25519.PublicKey
}

func main() {
	loadDotEnv(".env")

	cfg := config{
		NodeID:        getenv("NODE_ID", ""),
		ClaimToken:    getenv("NODE_CLAIM_TOKEN", ""),
		APIBaseURL:    strings.TrimRight(getenv("API_BASE_URL", "https://api.pulseofmesh.app"), "/"),
		AgentStateDir: getenv("AGENT_STATE_DIR", "./data"),
	}

	if len(os.Args) < 2 {
		log.Fatalf("usage: %s <register|auth-test|run>", filepath.Base(os.Args[0]))
	}

	command := os.Args[1]
	state, err := loadOrCreateState(cfg.AgentStateDir)
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
		if err := runRegister(cfg, api, state); err != nil {
			log.Fatal(err)
		}
	case "auth-test":
		if err := runAuthTest(cfg, api, state); err != nil {
			log.Fatal(err)
		}
	case "run":
		if err := runAuthTest(cfg, api, state); err != nil {
			log.Fatal(err)
		}
		log.Println("agent run succeeded")
	default:
		log.Fatalf("unknown command %q", command)
	}
}

func runRegister(cfg config, api *client, st state) error {
	if cfg.NodeID == "" || cfg.ClaimToken == "" {
		return errors.New("NODE_ID and NODE_CLAIM_TOKEN are required")
	}

	hardware, err := collectHardware()
	if err != nil {
		return err
	}

	log.Printf("agent hardware collected: hostname=%v os=%v arch=%v", hardware["hostname"], hardware["os"], hardware["arch"])

	publicKeyDER, err := x509.MarshalPKIXPublicKey(st.publicKey)
	if err != nil {
		return err
	}

	var response registerResponse
	if err := api.post("/agent/register", map[string]any{
		"nodeId":       cfg.NodeID,
		"claimToken":   cfg.ClaimToken,
		"publicKey":    base64.StdEncoding.EncodeToString(publicKeyDER),
		"agentVersion": agentVersion,
		"hardware":     hardware,
	}, &response); err != nil {
		return err
	}

	if !response.OK || !response.Registered {
		return errors.New("registration was not acknowledged by server")
	}

	if err := writeFile(filepath.Join(cfg.AgentStateDir, "server_public_key.txt"), []byte(response.ServerPublicKey), 0o600); err != nil {
		return err
	}

	log.Printf("agent registration success for node %s", cfg.NodeID)
	return nil
}

func runAuthTest(cfg config, api *client, st state) error {
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
		if err := writeFile(filepath.Join(cfg.AgentStateDir, "server_public_key.txt"), []byte(challenge.ServerPublicKey), 0o600); err != nil {
			return err
		}
	}

	log.Printf("agent auth success for node %s", cfg.NodeID)
	return nil
}

func loadOrCreateState(dir string) (state, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return state{}, err
	}

	privateKeyPath := filepath.Join(dir, "agent_private_key.pem")
	publicKeyPath := filepath.Join(dir, "agent_public_key.pem")

	if _, err := os.Stat(privateKeyPath); errors.Is(err, os.ErrNotExist) {
		publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return state{}, err
		}

		privateDER, err := x509.MarshalPKCS8PrivateKey(privateKey)
		if err != nil {
			return state{}, err
		}

		publicDER, err := x509.MarshalPKIXPublicKey(publicKey)
		if err != nil {
			return state{}, err
		}

		if err := writePEM(privateKeyPath, "PRIVATE KEY", privateDER, 0o600); err != nil {
			return state{}, err
		}

		if err := writePEM(publicKeyPath, "PUBLIC KEY", publicDER, 0o644); err != nil {
			return state{}, err
		}

		log.Printf("agent keypair created in %s", dir)
		return state{privateKey: privateKey, publicKey: publicKey}, nil
	}

	privateDER, err := readPEM(privateKeyPath)
	if err != nil {
		return state{}, err
	}

	publicDER, err := readPEM(publicKeyPath)
	if err != nil {
		return state{}, err
	}

	privateKeyAny, err := x509.ParsePKCS8PrivateKey(privateDER)
	if err != nil {
		return state{}, err
	}

	publicKeyAny, err := x509.ParsePKIXPublicKey(publicDER)
	if err != nil {
		return state{}, err
	}

	privateKey, ok := privateKeyAny.(ed25519.PrivateKey)
	if !ok {
		return state{}, errors.New("stored private key is not ed25519")
	}

	publicKey, ok := publicKeyAny.(ed25519.PublicKey)
	if !ok {
		return state{}, errors.New("stored public key is not ed25519")
	}

	return state{privateKey: privateKey, publicKey: publicKey}, nil
}

func collectHardware() (map[string]any, error) {
	hostname, _ := os.Hostname()
	cpuModel := readFirstMatchingValue("/proc/cpuinfo", "model name")
	memMB := readMemTotalMB("/proc/meminfo")
	machineID := firstExistingFile("/etc/machine-id", "/var/lib/dbus/machine-id")

	return map[string]any{
		"hostname":    hostname,
		"os":          runtime.GOOS,
		"arch":        runtime.GOARCH,
		"cpuModel":    cpuModel,
		"cpuCores":    runtime.NumCPU(),
		"memoryMB":    memMB,
		"machineId":   strings.TrimSpace(machineID),
		"fingerprint": hardwareFingerprint(hostname, cpuModel, machineID),
	}, nil
}

func hardwareFingerprint(hostname, cpuModel, machineID string) string {
	sum := sha256.Sum256([]byte(strings.Join([]string{
		hostname,
		runtime.GOOS,
		runtime.GOARCH,
		cpuModel,
		strings.TrimSpace(machineID),
	}, "|")))

	return hex.EncodeToString(sum[:])
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
		return fmt.Errorf("request to %s failed with %s: %s", path, response.Status, strings.TrimSpace(string(responseBody)))
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
