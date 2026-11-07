// T3 Manager extension (not part of upstream CLIProxyAPI).
//
// Exposes the existing Codex device-code flow as two steps so the T3 Manager
// dashboard can show the user code in its own UI instead of the CLI printing it.
// It only reuses unexported helpers from codex_device.go and changes none of them.
// See services/proxy/T3_PATCHES.md.

package auth

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/auth/codex"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/util"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

// CodexDeviceCode is a pending Codex device authorization.
type CodexDeviceCode struct {
	DeviceAuthID    string
	UserCode        string
	VerificationURL string
	Interval        time.Duration
	ExpiresAt       time.Time
}

// RequestCodexDeviceCode starts a Codex device authorization and returns the
// code the user must enter at VerificationURL.
func RequestCodexDeviceCode(ctx context.Context, cfg *config.Config) (*CodexDeviceCode, error) {
	if cfg == nil {
		return nil, fmt.Errorf("cliproxy auth: configuration is required")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	httpClient := util.SetProxy(&cfg.SDKConfig, &http.Client{Timeout: 30 * time.Second})
	resp, err := requestCodexDeviceUserCode(ctx, httpClient)
	if err != nil {
		return nil, err
	}
	userCode := strings.TrimSpace(resp.UserCode)
	if userCode == "" {
		userCode = strings.TrimSpace(resp.UserCodeAlt)
	}
	deviceAuthID := strings.TrimSpace(resp.DeviceAuthID)
	if userCode == "" || deviceAuthID == "" {
		return nil, fmt.Errorf("codex device flow did not return required fields")
	}
	return &CodexDeviceCode{
		DeviceAuthID:    deviceAuthID,
		UserCode:        userCode,
		VerificationURL: codexDeviceVerificationURL,
		Interval:        parseCodexDevicePollInterval(resp.Interval),
		ExpiresAt:       time.Now().Add(codexDeviceTimeout),
	}, nil
}

// CompleteCodexDeviceLogin polls until the user approves the code, exchanges
// the authorization code and returns an unsaved credential record.
func CompleteCodexDeviceLogin(ctx context.Context, cfg *config.Config, code *CodexDeviceCode) (*coreauth.Auth, error) {
	if cfg == nil || code == nil {
		return nil, fmt.Errorf("cliproxy auth: configuration and device code are required")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	httpClient := util.SetProxy(&cfg.SDKConfig, &http.Client{Timeout: 30 * time.Second})
	tokenResp, err := pollCodexDeviceToken(ctx, httpClient, code.DeviceAuthID, code.UserCode, code.Interval)
	if err != nil {
		return nil, err
	}
	authCode := strings.TrimSpace(tokenResp.AuthorizationCode)
	codeVerifier := strings.TrimSpace(tokenResp.CodeVerifier)
	codeChallenge := strings.TrimSpace(tokenResp.CodeChallenge)
	if authCode == "" || codeVerifier == "" || codeChallenge == "" {
		return nil, fmt.Errorf("codex device flow token response missing required fields")
	}
	authSvc := codex.NewCodexAuth(cfg)
	bundle, err := authSvc.ExchangeCodeForTokensWithRedirect(ctx, authCode, codexDeviceTokenExchangeRedirectURI,
		&codex.PKCECodes{CodeVerifier: codeVerifier, CodeChallenge: codeChallenge})
	if err != nil {
		return nil, codex.NewAuthenticationError(codex.ErrCodeExchangeFailed, err)
	}
	return NewCodexAuthenticator().buildAuthRecord(authSvc, bundle)
}

// presetAuthenticator returns an already-obtained record so it can be saved
// through Manager.Login, which applies upstream's merge and persistence rules.
type presetAuthenticator struct {
	provider string
	record   *coreauth.Auth
}

func (p *presetAuthenticator) Provider() string            { return p.provider }
func (p *presetAuthenticator) RefreshLead() *time.Duration { return nil }
func (p *presetAuthenticator) Login(context.Context, *config.Config, *LoginOptions) (*coreauth.Auth, error) {
	return p.record, nil
}

// SaveLoginRecord persists a credential obtained outside an Authenticator using
// the registered token store, exactly as an interactive login would.
func SaveLoginRecord(ctx context.Context, cfg *config.Config, record *coreauth.Auth) (string, error) {
	if record == nil {
		return "", fmt.Errorf("cliproxy auth: record is required")
	}
	provider := strings.TrimSpace(record.Provider)
	if provider == "" {
		provider = "codex"
	}
	mgr := NewManager(GetTokenStore(), &presetAuthenticator{provider: provider, record: record})
	_, saved, err := mgr.Login(ctx, provider, cfg, &LoginOptions{NoBrowser: true})
	return saved, err
}
