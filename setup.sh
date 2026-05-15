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
#   4. 复制配置模板（动态检测脚本目录，不覆盖已有配置，敏感文件需确认）
#   5. 检测/安装 ngrok
#   6. 引导用户配置飞书 Sisyphus 机器人
#   7. 自动发现机器人所在群聊并让用户选择分配
#   8. 启动 openplaw 网关 + ngrok 隧道
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

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

APP_ID=""
APP_SECRET=""
VERIFICATION_TOKEN=""
ENCRYPT_KEY=""
NGROK_PUBLIC_URL=""
DISCOVERED_GROUPS=""

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

# ═══════════════════════════════════════════════════════════════════════════
# 从脚本所在目录的 config/ 子目录复制配置模板到 ~/.config/openplaw/
# 规则：
#   - JSON 文件：已有则不覆盖（保留用户现有配置）
#   - 敏感文件（含 apiKey/appSecret/verificationToken/encryptKey）：已有则提示确认是否覆盖
#   - skills/mcp/credentials 子目录：内容合并（不删除用户已有的文件）
# ═══════════════════════════════════════════════════════════════════════════

is_sensitive_file() {
  local file="$1"
  if [ ! -f "$file" ]; then
    return 1
  fi
  grep -qiE '(apiKey|appSecret|verificationToken|encryptKey|AUTHTOKEN|PASSWORD|SECRET_KEY|ACCESS_TOKEN)' "$file" 2>/dev/null
}

copy_config() {
  local SCRIPT_DIR
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local TEMPLATE_DIR="$SCRIPT_DIR/config"

  if [ ! -d "$TEMPLATE_DIR" ]; then
    warn "未找到配置模板目录 ($TEMPLATE_DIR)，跳过配置复制"
    tip "如果你是从 npm 安装的，配置模板不包含在 npm 包中"
    return 0
  fi

  info "检测到配置模板目录: $TEMPLATE_DIR"
  mkdir -p "$CONFIG_DIR"

  local copied=0 skipped=0

  # ── 复制顶层 JSON 配置文件 ──
  for src_file in "$TEMPLATE_DIR"/*.json; do
    [ ! -f "$src_file" ] && continue
    local filename="$(basename "$src_file")"
    local dest_file="$CONFIG_DIR/$filename"

    if [ -f "$dest_file" ]; then
      # 目标已存在 → 判断是否敏感
      if is_sensitive_file "$dest_file"; then
        echo ""
        echo "  ${YELLOW}⚠ 发现敏感配置文件: ${filename}${NC}"
        echo "  ${DIM}该文件包含 apiKey/appSecret 等敏感信息，覆盖可能导致已有凭证丢失${NC}"
        echo ""
        read -rp "  ${BOLD}是否覆盖 ${filename}? (y/N):${NC} " overwrite
        if [ "$overwrite" = "y" ] || [ "$overwrite" = "Y" ]; then
          cp "$src_file" "$dest_file"
          info "已覆盖: $filename (用户确认)"
          copied=$((copied + 1))
        else
          info "已跳过: $filename (保留用户现有配置)"
          skipped=$((skipped + 1))
        fi
      else
        # 非敏感 JSON → 不覆盖，保留用户配置
        info "已跳过: $filename (已有配置，不覆盖)"
        skipped=$((skipped + 1))
      fi
    else
      # 目标不存在 → 直接复制
      cp "$src_file" "$dest_file"
      if is_sensitive_file "$dest_file"; then
        warn "已复制: $filename (⚠ 含敏感信息，请检查并替换为你自己的凭证)"
      else
        info "已复制: $filename"
      fi
      copied=$((copied + 1))
    fi
  done

  # ── 合并子目录内容（skills/mcp/credentials）──
  for subdir in skills mcp credentials; do
    local src_subdir="$TEMPLATE_DIR/$subdir"
    [ ! -d "$src_subdir" ] && continue
    local dest_subdir="$CONFIG_DIR/$subdir"
    mkdir -p "$dest_subdir"

    # 递归复制子目录内容
    for src_item in "$src_subdir"/*; do
      [ ! -e "$src_item" ] && continue
      local item_name="$(basename "$src_item")"
      local dest_item="$dest_subdir/$item_name"

      if [ -d "$src_item" ]; then
        # 子目录（如 skills/submit-code/） → 合并
        if [ -d "$dest_item" ]; then
          # 目标子目录已存在 → 逐文件合并
          for src_inner in "$src_item"/*; do
            [ ! -f "$src_inner" ] && continue
            local inner_name="$(basename "$src_inner")"
            local dest_inner="$dest_item/$inner_name"
            if [ -f "$dest_inner" ]; then
              if is_sensitive_file "$dest_inner"; then
                echo ""
                echo "  ${YELLOW}⚠ 发现敏感文件: ${subdir}/${item_name}/${inner_name}${NC}"
                read -rp "  ${BOLD}是否覆盖? (y/N):${NC} " overwrite_inner
                if [ "$overwrite_inner" = "y" ] || [ "$overwrite_inner" = "Y" ]; then
                  cp "$src_inner" "$dest_inner"
                  copied=$((copied + 1))
                else
                  skipped=$((skipped + 1))
                fi
              else
                info "已跳过: $subdir/$item_name/$inner_name (已有，不覆盖)"
                skipped=$((skipped + 1))
              fi
            else
              cp "$src_inner" "$dest_inner"
              if is_sensitive_file "$dest_inner"; then
                warn "已复制: $subdir/$item_name/$inner_name (⚠ 含敏感信息)"
              else
                info "已复制: $subdir/$item_name/$inner_name"
              fi
              copied=$((copied + 1))
            fi
          done
        else
          # 目标子目录不存在 → 整目录复制
          cp -r "$src_item" "$dest_item"
          info "已复制目录: $subdir/$item_name/"
          copied=$((copied + 1))
        fi
      elif [ -f "$src_item" ]; then
        # 普通文件 → 判断是否覆盖
        if [ -f "$dest_item" ]; then
          if is_sensitive_file "$dest_item"; then
            echo ""
            echo "  ${YELLOW}⚠ 发现敏感文件: ${subdir}/${item_name}${NC}"
            read -rp "  ${BOLD}是否覆盖? (y/N):${NC} " overwrite_file
            if [ "$overwrite_file" = "y" ] || [ "$overwrite_file" = "Y" ]; then
              cp "$src_item" "$dest_item"
              copied=$((copied + 1))
            else
              skipped=$((skipped + 1))
            fi
          else
            # .gitkeep 等文件 → 不覆盖已有
            info "已跳过: $subdir/$item_name (已有，不覆盖)"
            skipped=$((skipped + 1))
          fi
        else
          cp "$src_item" "$dest_item"
          if is_sensitive_file "$dest_item"; then
            warn "已复制: $subdir/$item_name (⚠ 含敏感信息)"
          else
            info "已复制: $subdir/$item_name"
          fi
          copied=$((copied + 1))
        fi
      fi
    done
  done

  echo ""
  if [ "$copied" -gt 0 ] || [ "$skipped" -gt 0 ]; then
    info "配置复制完成: ${copied} 个文件复制, ${skipped} 个文件跳过"
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

configure_bot() {
  local config_file="$CONFIG_DIR/openplaw.json"

  if [ -f "$config_file" ]; then
    local existing_config
    existing_config="$(cat "$config_file")"
    if echo "$existing_config" | python3 -c "import json,sys; d=json.load(sys.stdin); bots=d.get('bots',[]); exit(0 if len(bots)>0 else 1)" 2>/dev/null; then
      warn "openplaw.json 已有 bot 配置，跳过自动写入"
      info "你可以在 $config_file 中手动修改"
      local existing_bot
      existing_bot="$(echo "$existing_config" | python3 -c "import json,sys; d=json.load(sys.stdin); b=d['bots'][0]; print(f'{b[\"appId\"]}|{b[\"appSecret\"]}')")"
      if [ -n "$existing_bot" ]; then
        APP_ID="$(echo "$existing_bot" | cut -d'|' -f1)"
        APP_SECRET="$(echo "$existing_bot" | cut -d'|' -f2)"
        info "使用已有 bot 配置: App ID=$APP_ID"
      fi
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
    echo "     ${DIM}↑ ngrok 为你生成的公网地址${NC}"
  else
    echo "     ${BOLD}<你的公网URL>/webhook/feishu${NC}"
    echo ""
    echo "     ${DIM}URL 格式: https://xxxx.ngrok-free.app/webhook/feishu${NC}"
  fi

  echo ""
  echo "  ${CYAN}6.${NC} 在应用 > 机器人 > 页面启用机器人能力"
  echo "  ${CYAN}7.${NC} 在应用版本管理与发布 > 创建版本并发布"
  echo ""
  echo "  ${DIM}先把机器人添加到你需要它响应的飞书群聊中，下面会自动发现这些群${NC}"
  echo ""

  read -rp "  ${BOLD}App ID:${NC} " app_id
  read -rp "  ${BOLD}App Secret:${NC} " app_secret
  read -rp "  ${BOLD}Verification Token:${NC} " verification_token
  read -rp "  ${BOLD}Encrypt Key:${NC} " encrypt_key

  APP_ID="$app_id"
  APP_SECRET="$app_secret"
  VERIFICATION_TOKEN="$verification_token"
  ENCRYPT_KEY="$encrypt_key"

  if [ -z "$APP_ID" ] || [ -z "$APP_SECRET" ]; then
    warn "App ID 或 App Secret 为空，跳过配置写入"
    tip "你可以稍后手动编辑: $config_file"
    return 1
  fi
}

discover_groups() {
  if [ -z "$APP_ID" ] || [ -z "$APP_SECRET" ]; then
    warn "缺少 App ID 或 App Secret，无法自动发现群聊"
    echo ""
    echo "  ${BOLD}手动获取 chatId 方法:${NC}"
    echo ""
    echo "  ${CYAN}方法 1:${NC} 在飞书群里打开群设置 → 群信息 → 复制群链接"
    echo "        URL 中 chat_id= 后面的值就是 chatId"
    echo "        例: https://feishu.cn/group/chat?chat_id=oc_xxxxxabc"
    echo "        chatId 就是: oc_xxxxxabc"
    echo ""
    echo "  ${CYAN}方法 2:${NC} 先启动机器人，在群里发一条消息"
    echo "        查看 openplaw 日志，日志里会打印 chatId"
    echo ""
    DISCOVERED_GROUPS=""
    return 1
  fi

  tip "正在通过飞书 API 发现机器人所在群聊..."

  local feishu_token
  feishu_token="$(curl -s -X POST "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal" \
    -H "Content-Type: application/json" \
    -d "{\"app_id\":\"${APP_ID}\",\"app_secret\":\"${APP_SECRET}\"}" 2>/dev/null | \
    python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tenant_access_token',''))" 2>/dev/null || echo "")"

  if [ -z "$feishu_token" ]; then
    err "无法获取飞书 access token（App ID 或 App Secret 可能不正确）"
    echo ""
    echo "  ${BOLD}手动获取 chatId 方法:${NC}"
    echo ""
    echo "  ${CYAN}方法 1:${NC} 在飞书群里打开群设置 → 群信息 → 复制群链接"
    echo "        URL 中 chat_id= 后面的值就是 chatId"
    echo "        例: https://feishu.cn/group/chat?chat_id=oc_xxxxxabc"
    echo "        chatId 就是: oc_xxxxxabc"
    echo ""
    echo "  ${CYAN}方法 2:${NC} 先启动机器人，在群里发一条消息"
    echo "        查看 openplaw 日志，日志里会打印 chatId"
    echo ""
    DISCOVERED_GROUPS=""
    return 1
  fi

  local groups_json
  groups_json="$(curl -s "https://open.feishu.cn/open-apis/im/v1/chats?page_size=100" \
    -H "Authorization: Bearer ${feishu_token}" 2>/dev/null || echo "")"

  local group_count
  group_count="$(echo "$groups_json" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    items = d.get('data', {}).get('items', [])
    print(len(items))
except:
    print(0)
" 2>/dev/null || echo "0")"

  if [ "$group_count" -eq 0 ]; then
    warn "机器人尚未加入任何群聊"
    echo ""
    echo "  ${BOLD}请先把机器人添加到飞书群聊中:${NC}"
    echo ""
    echo "  ${CYAN}1.${NC} 在飞书开放平台 > 你的应用 > 机器人 > 启用机器人能力"
    echo "  ${CYAN}2.${NC} 创建版本并发布应用"
    echo "  ${CYAN}3.${NC} 在飞书群聊中添加机器人（群设置 → 群机器人 → 添加机器人 → 选择你的应用）"
    echo "  ${CYAN}4.${NC} 添加完成后，重新运行此脚本，脚本会自动发现群聊"
    echo ""
    echo "  ${BOLD}或者手动获取 chatId:${NC}"
    echo "  飞书群 → 群设置 → 群信息 → 复制群链接 → URL 中 chat_id= 后的值"
    echo "  例: https://feishu.cn/group/chat?chat_id=oc_xxxxxabc → chatId = oc_xxxxxabc"
    echo ""
    DISCOVERED_GROUPS=""
    return 1
  fi

  info "发现 $group_count 个群聊"
  echo ""
  echo "  ${BOLD}机器人所在的群聊:${NC}"
  echo ""

  echo "$groups_json" | python3 -c "
import json, sys
d = json.load(sys.stdin)
items = d.get('data', {}).get('items', [])
for i, item in enumerate(items, 1):
    chat_id = item.get('chat_id', '')
    name = item.get('name', '未命名群')
    external = '外部群' if item.get('external', False) else '内部群'
    print(f'  {i}. {name}  ({external})  chatId: {chat_id}')
"

  DISCOVERED_GROUPS="$(echo "$groups_json" | python3 -c "
import json, sys
d = json.load(sys.stdin)
items = d.get('data', {}).get('items', [])
result = []
for item in items:
    chat_id = item.get('chat_id', '')
    name = item.get('name', '')
    result.append(f'{chat_id}|{name}')
print('\\n'.join(result))
" 2>/dev/null || echo "")"
}

assign_groups() {
  local config_file="$CONFIG_DIR/openplaw.json"

  if [ -z "$DISCOVERED_GROUPS" ]; then
    tip "未发现群聊，写入默认配置（chatId 为空，机器人响应所有群）"
    python3 -c "
import json, os
config_file = '$config_file'
app_id = '$APP_ID'
app_secret = '$APP_SECRET'
verification_token = '$VERIFICATION_TOKEN' if '$VERIFICATION_TOKEN' else ''
encrypt_key = '$ENCRYPT_KEY' if '$ENCRYPT_KEY' else ''

existing = {}
if os.path.exists(config_file):
    try:
        with open(config_file) as f: existing = json.load(f)
    except: existing = {}

bots = existing.get('bots', [])
if not any(b.get('id') == 'sisyphus' for b in bots):
    bots.append({'id': 'sisyphus', 'agent': 'sisyphus', 'appId': app_id, 'appSecret': app_secret, 'verificationToken': verification_token, 'encryptKey': encrypt_key, 'botName': 'SisyphusBot'})

groups = existing.get('groups', [])
if not any(g.get('id') == 'default' for g in groups):
    groups.append({'id': 'default', 'chatId': '', 'name': 'default', 'bots': ['sisyphus']})

config = {'bots': bots, 'groups': groups, 'agents': existing.get('agents', {'directory': ['~/.openplaw/agents']}), 'mcp': existing.get('mcp', {'autoRegister': True}), 'ports': existing.get('ports', {'gateway': 3000, 'gatewayHost': '0.0.0.0', 'health': 9090, 'opencode': 4096, 'hub': 4097, 'web': 4098})}
with open(config_file, 'w') as f: json.dump(config, f, indent=2, ensure_ascii=False); f.write('\n')
"
    info "默认配置已写入: $config_file"
    return 0
  fi

  echo ""
  echo "  ${BOLD}选择哪些群聊分配给 Sisyphus 机器人:${NC}"
  echo ""
  echo "  ${CYAN}a.${NC} 所有群 → Sisyphus 全部响应"
  echo "  ${CYAN}s.${NC} 选择特定群 → 只在选中的群里响应"
  echo "  ${CYAN}n.${NC} 不分配 → chatId 留空（响应所有群，等同 a）"
  echo ""

  read -rp "  ${BOLD}你的选择 (a/s/n):${NC} " choice

  local selected_chatids=""

  case "$choice" in
    a|A|n|N|"")
      selected_chatids=""
      tip "Sisyphus 将响应所有群聊"
      ;;
    s|S)
      echo ""
      echo "  ${BOLD}请输入要分配的群聊编号（用逗号分隔，如: 1,3,5）:${NC}"
      echo ""

      local group_lines
      group_lines="$(echo "$DISCOVERED_GROUPS" | head -20)"
      local i=1
      while IFS= read -r line; do
        if [ -z "$line" ]; then continue; fi
        local g_name="$(echo "$line" | cut -d'|' -f2)"
        local g_id="$(echo "$line" | cut -d'|' -f1)"
        echo "  ${CYAN}${i}.${NC} ${g_name}  chatId: ${g_id}"
        i=$((i + 1))
      done <<< "$group_lines"

      echo ""
      read -rp "  ${BOLD}编号:${NC} " selected_nums

      selected_chatids="$(echo "$DISCOVERED_GROUPS" | python3 -c "
import sys
lines = sys.stdin.read().strip().split('\n')
nums = [int(x.strip()) for x in '$selected_nums'.split(',') if x.strip()]
result = []
for n in nums:
    if 1 <= n <= len(lines):
        parts = lines[n-1].split('|')
        result.append(parts[0])
print(','.join(result))
" 2>/dev/null || echo "")"
      ;;
    *)
      warn "无效选择，使用默认配置（响应所有群）"
      selected_chatids=""
      ;;
  esac

  python3 -c "
import json, os
config_file = '$config_file'
app_id = '$APP_ID'
app_secret = '$APP_SECRET'
verification_token = '$VERIFICATION_TOKEN' if '$VERIFICATION_TOKEN' else ''
encrypt_key = '$ENCRYPT_KEY' if '$ENCRYPT_KEY' else ''
selected = '$selected_chatids'.split(',') if '$selected_chatids' else []
discovered_lines = '$DISCOVERED_GROUPS'.split('\\n') if '$DISCOVERED_GROUPS' else []

existing = {}
if os.path.exists(config_file):
    try:
        with open(config_file) as f: existing = json.load(f)
    except: existing = {}

bots = existing.get('bots', [])
if not any(b.get('id') == 'sisyphus' for b in bots):
    bots.append({'id': 'sisyphus', 'agent': 'sisyphus', 'appId': app_id, 'appSecret': app_secret, 'verificationToken': verification_token, 'encryptKey': encrypt_key, 'botName': 'SisyphusBot'})

groups = existing.get('groups', [])

if selected:
    for chat_id in selected:
        chat_id = chat_id.strip()
        if not chat_id: continue
        group_name = '未知群'
        for line in discovered_lines:
            parts = line.split('|')
            if len(parts) >= 2 and parts[0] == chat_id:
                group_name = parts[1]
                break
        group_id = chat_id.replace('oc_', '')
        if not any(g.get('chatId') == chat_id for g in groups):
            groups.append({'id': group_id, 'chatId': chat_id, 'name': group_name, 'bots': ['sisyphus']})
else:
    if not any(g.get('id') == 'default' for g in groups):
        groups.append({'id': 'default', 'chatId': '', 'name': 'default', 'bots': ['sisyphus']})

config = {'bots': bots, 'groups': groups, 'agents': existing.get('agents', {'directory': ['~/.openplaw/agents']}), 'mcp': existing.get('mcp', {'autoRegister': True}), 'ports': existing.get('ports', {'gateway': 3000, 'gatewayHost': '0.0.0.0', 'health': 9090, 'opencode': 4096, 'hub': 4097, 'web': 4098})}
with open(config_file, 'w') as f: json.dump(config, f, indent=2, ensure_ascii=False); f.write('\n')
print('ok')
"

  info "群聊配置已写入: $config_file"
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
  sleep 3

  NGROK_PUBLIC_URL="$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    for t in data.get('tunnels', []):
        if t.get('proto') == 'https': print(t['public_url']); break
except: pass
" 2>/dev/null || echo "")"

  if [ -n "$NGROK_PUBLIC_URL" ]; then
    info "ngrok 隧道已启动"
    echo ""
    echo "  ${BOLD}${GREEN}公网 URL: ${NGROK_PUBLIC_URL}${NC}"
    echo ""
    echo "  ${DIM}这是你的飞书机器人回调地址${NC}"
    return 0
  else
    warn "无法获取 ngrok 公网 URL"
    tip "请访问 http://127.0.0.1:4040 查看隧道状态"
    return 1
  fi
}

show_summary() {
  echo ""
  echo "${BOLD}${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo "${BOLD}${GREEN}║            🎉 openplaw 安装配置完成！                      ║${NC}"
  echo "${BOLD}${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo "  ${BOLD}配置文件:${NC}"
  echo "    $CONFIG_DIR/openplaw.json"
  echo ""
  echo "  ${BOLD}常用命令:${NC}"
  echo "    openplaw start       启动网关"
  echo "    openplaw config      查看配置"
  echo "    openplaw init        重新初始化"
  echo "    openplaw web         管理界面"
  echo ""

  if [ -n "$NGROK_PUBLIC_URL" ]; then
    echo "  ${BOLD}公网回调 URL:${NC}"
    echo "    ${CYAN}${NGROK_PUBLIC_URL}/webhook/feishu${NC}"
    echo ""
    echo "  ${DIM}在飞书开放平台 > 事件与回调 > 事件配置 中设置此 URL${NC}"
    echo ""
  fi

  echo "  ${BOLD}chatId 获取方式:${NC}"
  echo "    ${CYAN}自动:${NC} 此脚本已通过飞书 API 自动发现群聊"
  echo "    ${CYAN}手动:${NC} 飞书群 → 群设置 → 群信息 → 复制群链接 → URL 中 chat_id= 后的值"
  echo "    ${CYAN}日志:${NC} 启动后群里发消息，openplaw 日志会打印 chatId"
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

  step "复制配置模板"
  copy_config

  step "安装 ngrok"
  install_ngrok

  step "配置飞书 Sisyphus 机器人"
  configure_bot

  step "自动发现群聊并分配"
  discover_groups
  assign_groups

  step "启动 openplaw 网关"
  start_gateway

  step "启动 ngrok 隧道"
  start_ngrok

  show_summary
}

main