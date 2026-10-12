#!/usr/bin/env bash
# 代码属于 root、服务以专用用户运行的部署:让管理后台「系统更新」可以更新这个实例。
# 以 root 在仓库里运行,每个实例一次(以后 deploy/ 有改动时再跑一次):
#   sudo bash deploy/update-helper-setup.sh <实例名>...
# 实例名对应 /etc/cat-agentui/instances.d/<实例名>.conf,格式见 deploy/cat-agentui-update 开头。
# 面板只能往收件箱里放一行请求,真正的更新由 root 运行的 cat-agentui-update 完成。
set -euo pipefail
if [[ $EUID -ne 0 || $# -eq 0 ]]; then
  echo "用法:sudo bash $0 <实例名>...(已配置的实例:cat-agentui-update --list)" >&2; exit 1
fi
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target=/usr/local/sbin/cat-agentui-update

# 换掉手写的旧版之前留一份
if [[ -e "$target" && ! -e "$target.orig" ]] && ! cmp -s "$here/cat-agentui-update" "$target"; then
  cp -a "$target" "$target.orig"
  echo "原来的 $target 已保存为 $target.orig"
fi
install -m 0755 "$here/cat-agentui-update" "$target"
install -m 0644 "$here/cat-agentui-update@.service" "$here/cat-agentui-update@.path" /etc/systemd/system/
systemctl daemon-reload
for instance in "$@"; do
  "$target" --enable-panel "$instance"
done
echo "完成。打开对应面板的 管理后台 → 系统更新,点「检查更新」验证。"
