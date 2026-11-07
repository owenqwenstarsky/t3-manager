// T3 Manager extension hook (not part of upstream CLIProxyAPI).
// See services/proxy/T3_PATCHES.md.

package main

import (
	"github.com/router-for-me/CLIProxyAPI/v8/internal/api"
	"github.com/router-for-me/CLIProxyAPI/v8/t3ext"
)

func t3extServerOptions() []api.ServerOption {
	return t3ext.ServerOptions()
}
