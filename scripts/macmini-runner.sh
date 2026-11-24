#!/bin/bash
set -e
TOKEN="$1"
[ -n "$TOKEN" ] || { echo "缺少令牌"; exit 1; }
REPO=https://github.com/cryptoshatter/liuguang
DIR="$HOME/actions-runner"
ARCH=$([ "$(uname -m)" = arm64 ] && echo arm64 || echo x64)
V=$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p')

mkdir -p "$DIR" && cd "$DIR"
if [ ! -x ./config.sh ]; then
  curl -fsSL -o runner.tar.gz "https://github.com/actions/runner/releases/download/v$V/actions-runner-osx-$ARCH-$V.tar.gz"
  tar xzf runner.tar.gz && rm runner.tar.gz
fi
./config.sh --url "$REPO" --token "$TOKEN" --name macmini --labels macmini --unattended --replace

PLIST=/Library/LaunchDaemons/com.liuguang.runner.plist
echo "接下来需要输入一次这台 Mac 的开机密码"
sudo tee "$PLIST" >/dev/null <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.liuguang.runner</string>
<key>UserName</key><string>$(whoami)</string>
<key>WorkingDirectory</key><string>$DIR</string>
<key>ProgramArguments</key><array><string>$DIR/runsvc.sh</string></array>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>$HOME</string><key>PATH</key><string>$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$DIR/runner.log</string>
<key>StandardErrorPath</key><string>$DIR/runner.log</string>
</dict></plist>
P
[ -f runsvc.sh ] || cp bin/runsvc.sh runsvc.sh
sudo launchctl bootout system "$PLIST" 2>/dev/null || true
sudo launchctl bootstrap system "$PLIST"
sudo pmset -a sleep 0 disksleep 0 autorestart 1
echo "完成：Mac mini 已作为打包机器上线"
