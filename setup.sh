#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════
# openplaw 一键安装启动脚本
# ═══════════════════════════════════════════════════════════════════════════
#
# 功能：
#   1. 检测/安装 Node.js (>=22)
#   2. 检测/安装/更新 @openplaw/openplaw
#   3. 初始化配置目录
#   4. 检测/安装 ngrok
#   5. 启动 openplaw 网关
#   6. 启动 ngrok 代理网关端口
#   7. 引导用户配置飞书 Sisyphus 机器人
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/cviews/openplaw/main/setup.sh | bash
#   或者本地执行：./setup.sh
#
# ═══════════════════════════════════════════════════════════════════════════

GATEWAY_PORT=3000
PKG_NAME="@openplaw/openplaw"
CONFIG_DIR="${OPENMO_CONFIG_HOME:-$HOME/.config/openplaw}"
DATA_DIR="${OPENMO_HOME:-$HOME/.openplaw}"
NGROK_CHECK_URL="https://ngrok-agent-download-hook"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

step_num=0
step() { step_num=$((step_num + 1)); echo ""; echo "${BOLD}${CYAN}━━━ Step $step_num: $1 ━━━${NC}"; echo ""; }
info() { echo "  ${GREEN}✓${NC} $1"; }
warn() { echo "  ${YELLOW}⚠${NC} $1"; }
err()  { echo "  ${RED}✗${NC} $1"; }
tip()  { echo "  ${BLUE}💡${NC} $1"; }

command_exists() { command -v "$1" >/dev/null 2>&1; }

get_latest_version() {
  curl -s "https://registry.npmjs.org/${PKG_NAME}/latest" 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin).get('version',''))" 2>/dev/null || echo ""
}

get_installed_version() {
  if command -v openplaw >/dev/null 2>&1; then
    openplaw version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo ""
  else
    echo ""
  fi
}

detect_platform() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$os" in
    darwin) os="darwin" ;;
    linux)  os="linux" ;;
    *)      err "Unsupported OS: $os"; return 1 ;;
  esac
  case "$arch" in
    x86_64|amd64)   arch="x64" ;;
    arm64|aarch64)  arch="arm64" ;;
    *)              err "Unsupported arch: $arch"; return 1 ;;
  esac
  echo "${os}-${arch}"
}

install_node() {
  if command_exists node; then
    local ver
    ver="$(node --version | sed 's/v//')"
    local major="${ver%%.*}"
    if [ "$major" -ge 22 ]; then
      info "Node.js $ver 已安装 (>= 22)"
      return 0
    fi
    warn "Node.js $ver 版本过低，需要 >= 22"
  fi

  tip "正在安装 Node.js 22..."
  if command_exists brew; then
    brew install node@22 && brew link node@22 --force
  elif command_exists fnm; then
    fnm install 22 && fnm use 22
  elif command_exists nvm; then
    nvm install 22 && nvm use 22
  else
    curl -fsSL https://fnm.vercel.app/install | bash
    export PATH="$HOME/.local/bin:$PATH"
    eval "$(fnm env)"
    fnm install 22 && fnm use 22
  fi

  if command_exists node; then
    info "Node.js $(node --version) 安装成功"
  else
    err "Node.js 安装失败，请手动安装 Node.js >= 22"
    return 1
  fi
}

install_openplaw() {
  local latest installed
  latest="$(get_latest_version)"
  installed="$(get_installed_version)"

  if [ -z "$latest" ]; then
    warn "无法获取最新版本号，跳过版本检测"
    latest="unknown"
  fi

  if [ -n "$installed" ] && [ "$installed" = "$latest" ]; then
    info "openplaw $installed 已是最新版本"
    return 0
  fi

  if [ -n "$installed" ]; then
    tip "当前版本 $installed，最新版本 $latest，正在更新..."
    npm update -g "$PKG_NAME" 2>/dev/null || npm install -g "$PKG_NAME@latest"
  else
    tip "正在安装 openplaw..."
    npm install -g "$PKG_NAME@latest"
  fi

  installed="$(get_installed_version)"
  if [ -n "$installed" ]; then
    info "openplaw $installed 安装成功"
  else
    err "openplaw 安装失败"
    return 1
  fi
}

init_config() {
  if command_exists openplaw; then
    openplaw init --force
    info "配置目录已初始化"
  else
    mkdir -p "$DATA_DIR/agents" "$DATA_DIR/mcp" "$DATA_DIR/skills" "$DATA_DIR/bindings"
    mkdir -p "$CONFIG_DIR/agents" "$CONFIG_DIR/mcp" "$CONFIG_DIR/skills" "$CONFIG_DIR/credentials"
    for f in openplaw.json opencode.json omo.json; do
      [ ! -f "$CONFIG_DIR/$f" ] && echo '{}' > "$CONFIG_DIR/$f"
    done
    info "配置目录已手动创建"
  fi
}

install_ngrok() {
  if command_exists ngrok; then
    info "ngrok 已安装 ($(ngrok version 2>/dev/null | head -1 || echo 'unknown'))"
    return 0
  fi

  tip "正在安装 ngrok..."
  local plat
  plat="$(detect_platform)"

  case "$plat" in
    darwin-arm64)
      if command_exists brew; then
        brew install ngrok/ngrok/ngrok
      else
        curl -sL https://bin.equinox.io/c/bNyj1mQqSj/ngrok-v3-stable-darwin-arm64.tgz | tar xz -C /usr/local/bin/
      fi
      ;;
    darwin-x64)
      if command_exists brew; then
        brew install ngrok/ngrok/ngrok
      else
        curl -sL https://bin.equinox.io/c/bNyj1mQqSj/ngrok-v3-stable-darwin-x64.tgz | tar xz -C /usr/local/bin/
      fi
      ;;
    linux-arm64)
      curl -sL https://bin.equinox.io/c/bNyj1mQqSj/ngrok-v3-stable-linux-arm64.tgz | sudo tar xz -C /usr/local/bin/
      ;;
    linux-x64)
      curl -sL https://bin.equinox.io/c/bNyj1mQqSj/ngrok-v3-stable-linux-x64.tgz | sudo tar xz -C /usr/local/bin/
      ;;
    *)
      err "无法为 $plat 自动安装 ngrok"
      tip "请手动安装: https://ngrok.com/download"
      return 1
      ;;
  esac

  if command_exists ngrok; then
    info "ngrok 安装成功"
  else
    err "ngrok 安装失败"
    tip "请手动安装: https://ngrok.com/download"
    tip "安装后运行: ngrok config add-authtoken <你的token>"
    return 1
  fi
}

check_ngrok_auth() {
  if ! command_exists ngrok; then
    warn "ngrok 未安装，跳过 authtoken 检测"
    return 1
  fi

  local config_path="$HOME/.ngrok2/ngrok.yml"
  if [ ! -f "$config_path" ]; then
    config_path="$HOME/.config/ngrok/ngrok.yml"
  fi

  if [ -f "$config_path" ] && grep -q "authtoken" "$config_path" 2>/dev/null; then
    info "ngrok authtoken 已配置"
    return 0
  fi

  echo ""
  echo "${BOLD}${YELLOW}━━━ ngrok 需要配置 authtoken ━━━${NC}"
  echo ""
  echo "  ngrok 需要一个 authtoken 才能创建隧道。获取步骤："
  echo ""
  echo "  ${CYAN}1.${NC} 注册 ngrok 账号:  https://dashboard.ngrok.com/signup"
  echo "  ${CYAN}2.${NC} 登录后在页面:     https://dashboard.ngrok.com/get-started/your-authtoken"
  echo "  ${CYAN}3.${NC} 复制你的 authtoken"
  echo "  ${CYAN}4.${NC} 运行以下命令配置:"
  echo ""
  echo "     ${BOLD}ngrok config add-authtoken <你复制的token>${NC}"
  echo ""
  read -rp "  ${BOLD}请输入你的 ngrok authtoken (或按 Enter 跳过):${NC} " ngrok_token
  if [ -n "$ngrok_token" ]; then
    ngrok config add-authtoken "$ngrok_token"
    info "ngrok authtoken 已配置"
    return 0
  fi
  warn "跳过 ngrok authtoken 配置 — ngrok 将无法创建隧道"
  return 1
}

start_gateway() {
  tip "正在启动 openplaw 网关 (端口 $GATEWAY_PORT)..."
  openplaw start &
  local pid=$!
  sleep 3

  if kill -0 "$pid" 2>/dev/null; then
    info "openplaw 网关已启动 (PID: $pid, 端口: $GATEWAY_PORT)"
  else
    warn "网关可能未启动成功，请检查日志"
  fi
}

start_ngrok() {
  if ! command_exists ngrok; then
    warn "ngrok 未安装，跳过隧道启动"
    tip "你需要手动配置公网 URL 或安装 ngrok"
    return 1
  fi

  if ! check_ngrok_auth; then
    return 1
  fi

  tip "正在启动 ngrok 隧道 (代理端口 $GATEWAY_PORT)..."
  ngrok http "$GATEWAY_PORT" --log=stdout >/tmp/openplaw-ngrok.log 2>&1 &
  local ngrok_pid=$!
  sleep 3

  local ngrok_url
  ngrok_url="$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    tunnels = data.get('tunnels', [])
    for t in tunnels:
        if t.get('proto') == 'https':
            print(t['public_url'])
            break
except: pass
" 2>/dev/null || echo "")"

  if [ -n "$ngrok_url" ]; then
    info "ngrok 隧道已启动"
    echo ""
    echo "  ${BOLD}${GREEN}公网 URL: ${ngrok_url}${NC}"
    echo ""
    echo "  ${DIM}这是你的飞书机器人回调地址，下面配置时需要用到${NC}"
    NGROK_PUBLIC_URL="$ngrok_url"
    return 0
  else
    warn "无法获取 ngrok 公网 URL"
    tip "请访问 http://127.0.0.1:4040 查看隧道状态"
    return 1
  fi
}

write_sisyphus_config() {
  local config_file="$CONFIG_DIR/openplaw.json"
  local existing_config

  if [ -f "$config_file" ]; then
    existing_config="$(cat "$config_file")"
    if echo "$existing_config" | python3 -c "import json,sys; d=json.load(sys.stdin); bots=d.get('bots',[]); exit(0 if len(bots)>0 else 1)" 2>/dev/null; then
      warn "openplaw.json 已有 bot 配置，跳过自动写入"
      info "你可以在 $config_file 中手动修改"
      return 0
    fi
  fi

  echo ""
  echo "${BOLD}${CYAN}━━━ 配置 Sisyphus 飞书机器人 ━━━${NC}"
  echo ""
  echo "  需要以下 4 个参数（从飞书开放平台获取）："
  echo ""
  echo "  ${CYAN}App ID${NC}              — 应用凭证，飞书开放平台 > 你的应用 > 凭证与基础信息"
  echo "  ${CYAN}App Secret${NC}          — 应用密钥，同上页面"
  echo "  ${CYAN}Verification Token${NC}  — 事件订阅验证令牌，飞书开放平台 > 事件与回调 > 事件配置"
  echo "  ${CYAN}Encrypt Key${NC}         — 事件加密密钥，同上页面"
  echo ""
  echo "  ${BOLD}如何获取这些参数？${NC}"
  echo ""
  echo "  ${CYAN}1.${NC} 打开飞书开放平台: https://open.feishu.cn/app"
  echo "  ${CYAN}2.${NC} 创建企业自建应用（或使用已有应用）"
  echo "  ${CYAN}3.${NC} 进入应用 > 凭证与基础信息 → 复制 App ID 和 App Secret"
  echo "  ${CYAN}4.${NC} 进入应用 > 事件与回调 > 事件配置 → 复制 Verification Token 和 Encrypt Key"
  echo "  ${CYAN}5.${NC} 在事件配置页设置请求地址 URL 为:"
  echo ""

  if [ -n "${NGROK_PUBLIC_URL:-}" ]; then
    echo "     ${BOLD}${GREEN}${NGROK_PUBLIC_URL}/webhook/feishu${NC}"
    echo ""
    echo "     ${DIM}↑ 这是 ngrok 为你生成的公网地址${NC}"
  else
    echo "     ${BOLD}<你的公网URL>/webhook/feishu${NC}"
    echo ""
    echo "     ${DIM}如果你有 ngrok 隧道，URL 格式为: https://xxxx.ngrok-free.app/webhook/feishu${NC}"
  fi

  echo ""
  echo "  ${CYAN}6.${NC} 在应用 > 机器人 > 页面启用机器人能力"
  echo "  ${CYAN}7.${NC} 在应用版本管理与发布 > 创建版本并发布"
  echo ""

  read -rp "  ${BOLD}App ID:${NC} " app_id
  read -rp "  ${BOLD}App Secret:${NC} " app_secret
  read -rp "  ${BOLD}Verification Token:${NC} " verification_token
  read -rp "  ${BOLD}Encrypt Key:${NC} " encrypt_key

  if [ -z "$app_id" ] || [ -z "$app_secret" ]; then
    warn "App ID 或 App Secret 为空，跳过配置写入"
    tip "你可以稍后手动编辑: $config_file"
    return 1
  fi

  local webhook_url=""
  if [ -n "${NGROK_PUBLIC_URL:-}" ]; then
    webhook_url="${NGROK_PUBLIC_URL}/webhook/feishu"
  fi

  python3 -c "
import json, os, sys

config_file = '$config_file'
app_id = '$app_id'
app_secret = '$app_secret'
verification_token = '$verification_token' if '$verification_token' else ''
encrypt_key = '$encrypt_key' if '$encrypt_key' else ''
webhook_url = '$webhook_url'

existing = {}
if os.path.exists(config_file):
    try:
        with open(config_file) as f:
            existing = json.load(f)
    except:
        existing = {}

bots = existing.get('bots', [])
has_sisyphus = any(b.get('id') == 'sisyphus' for b in bots)

if not has_sisyphus:
    bots.append({
        'id': 'sisyphus',
        'agent': 'sisyphus',
        'appId': app_id,
        'appSecret': app_secret,
        'verificationToken': verification_token,
        'encryptKey': encrypt_key,
        'botName': 'SisyphusBot'
    })

groups = existing.get('groups', [])
has_default = any(g.get('id') == 'default' for g in groups)

if not has_default:
    groups.append({
        'id': 'default',
        'chatId': '',
        'name': 'default',
        'bots': ['sisyphus']
    })

config = {
    'bots': bots,
    'groups': groups,
    'agents': existing.get('agents', {'directory': '~/.openplaw/agents'}),
    'mcp': existing.get('mcp', {'autoRegister': True}),
    'session': existing.get('session', {})
}

with open(config_file, 'w') as f:
    json.dump(config, f, indent=2, ensure_ascii=False)
    f.write('\n')

print('ok')
"

  if [ $? -eq 0 ]; then
    info "Sisyphus 机器人配置已写入: $config_file"
  else
    err "配置写入失败"
  fi
}

show_summary() {
  echo ""
  echo "${BOLD}${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo "${BOLD}${GREEN}║            🎉 openplaw 安装配置完成！                      ║${NC}"
  echo "${BOLD}${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo "  ${BOLD}配置文件位置:${NC}"
  echo "    主配置:  $CONFIG_DIR/openplaw.json"
  echo "    凭证:    $CONFIG_DIR/credentials/"
  echo "    数据:    $DATA_DIR/"
  echo ""
  echo "  ${BOLD}常用命令:${NC}"
  echo "    启动网关:    openplaw start"
  echo "    查看配置:    openplaw config"
  echo "    重新初始化:  openplaw init"
  echo "    管理界面:    openplaw web"
  echo "    后台运行:    openplaw daemon install && openplaw daemon start"
  echo ""

  if [ -n "${NGROK_PUBLIC_URL:-}" ]; then
    echo "  ${BOLD}公网地址:${NC}"
    echo "    ${GREEN}${NGROK_PUBLIC_URL}/webhook/feishu${NC}"
    echo ""
  fi

  echo "  ${BOLD}飞书机器人回调 URL:${NC}"
  echo "    在飞书开放平台 > 事件与回调 > 事件配置 中设置请求地址为:"
  if [ -n "${NGROK_PUBLIC_URL:-}" ]; then
    echo "    ${CYAN}${NGROK_PUBLIC_URL}/webhook/feishu${NC}"
  else
    echo "    ${CYAN}<你的公网URL>/webhook/feishu${NC}"
  fi
  echo ""
  echo "  ${BOLD}目录结构说明:${NC}"
  echo ""
  echo "    ~/.openplaw/                   数据目录（内置 + 运行时）"
  echo "      ├── agents/                  内置代理（sisyphus 等）"
  echo "      ├── mcp/                     内置 MCP 服务配置"
  echo "      ├── skills/                  内置 skills"
  echo "      ├── bindings/                会话绑定数据"
  echo "      ├── sessions/                会话摘要存储"
  echo "      ├── MEMORY.md                全局记忆文件"
  echo "      └── logs/                    日志"
  echo ""
  echo "    ~/.config/openplaw/            配置目录（用户配置）"
  echo "      ├── openplaw.json            主配置（bot/group/agent）"
  echo "      ├── opencode.json            opencode 配置"
  echo "      ├── omo.json                 omo 配置"
  echo "      ├── agents/                  用户自定义代理"
  echo "      ├── mcp/                     用户自定义 MCP"
  echo "      ├── skills/                  用户自定义 skills"
  echo "      └── credentials/             飞书凭证文件"
  echo ""
  echo "  ${DIM}详细文档: https://github.com/cviews/openplaw${NC}"
  echo ""
}

main() {
  echo ""
  echo "${BOLD}${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo "${BOLD}${CYAN}║     openplaw 一键安装 — 飞书 Sisyphus 机器人               ║${NC}"
  echo "${BOLD}${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo ""

  step "检测 Node.js"
  install_node

  step "安装/更新 openplaw"
  install_openplaw

  step "初始化配置目录"
  init_config

  step "安装 ngrok"
  install_ngrok

  step "配置飞书 Sisyphus 机器人"
  write_sisyphus_config

  step "启动 openplaw 网关"
  start_gateway

  step "启动 ngrok 隧道"
  start_ngrok

  show_summary
}

main