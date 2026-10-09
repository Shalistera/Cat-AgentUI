// Shared UI words. Keys are the Chinese source strings passed to t().
export default {
  '请求失败 ({status})': 'Request failed ({status})',
  '上传失败': 'Upload failed',
  '保存失败': 'Failed to save',
  '语言': 'Language',
  '跟随浏览器': 'Follow browser',
  '当前浏览器为{lang}': 'Browser is set to {lang}',
  '中文': 'Chinese',
  '英文': 'English',
  '界面语言保存在账号里,在其他设备登录时也会沿用。「跟随浏览器」时,浏览器语言为中文显示中文,其余一律显示英文。':
    'Saved to your account and applied on other devices too. With "Follow browser", Chinese browsers get Chinese and everything else gets English.',
  // Same Chinese word, different English by context — see t()'s @@ note.
  '关闭@@off': 'Off',
  '启用@@state': 'Enabled',
  '生成图片@@stat': 'Images generated',
  '生成图片@@storage': 'Generated images',
  '收藏@@saved': 'Saved',
  '收藏@@model': 'Add to favorites',
  '取消收藏@@model': 'Remove from favorites',
  '用户@@nav': 'Users',
  '模型@@nav': 'Models',
  '正常@@health': 'Healthy',
  '图片@@file': 'Image',
  '搜索模型@@field': 'Search model',
  '恢复默认@@order': 'Reset order',
} satisfies Record<string, string>;
