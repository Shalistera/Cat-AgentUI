#!/usr/bin/env bash
# Cat-AgentUI 沙盒宿主机准备(Ubuntu / Debian)。以 root 运行一次:
#   sudo bash deploy/sandbox-host-setup.sh <运行面板的系统用户>
# 之后回到 管理后台 → 沙盒 点「重新检测」。
set -euo pipefail
SERVICE_USER="${1:-${SUDO_USER:-}}"
if [[ -z "$SERVICE_USER" ]]; then
  echo "用法:sudo bash $0 <运行面板的系统用户>" >&2; exit 1
fi

apt-get update
# bubblewrap:隔离;python3-venv:运行库环境;pandoc / poppler:文档转换;字体:图表与 PDF 里的中文
apt-get install -y bubblewrap python3 python3-venv pandoc fonts-noto-cjk poppler-utils fontconfig \
  libpango-1.0-0 libpangoft2-1.0-0 libcairo2 libgdk-pixbuf-2.0-0 libharfbuzz0b   # 最后一行供 weasyprint(HTML→PDF)

# Ubuntu 23.10+ 默认禁止非特权用户命名空间,bwrap 需要它(其他发行版本身即为 0,写入无害)
if [[ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]]; then
  echo 'kernel.apparmor_restrict_unprivileged_userns = 0' > /etc/sysctl.d/60-userns.conf
  sysctl --system >/dev/null
fi

# 让服务用户的 systemd 实例常驻,资源限额(内存 / CPU / 进程数)才能生效
loginctl enable-linger "$SERVICE_USER"

echo "完成。以 $SERVICE_USER 身份验证:"
echo "  bwrap --ro-bind /usr /usr --symlink usr/lib /lib --symlink usr/bin /bin --proc /proc --dev /dev --unshare-all -- /bin/true && echo sandbox-ok"
