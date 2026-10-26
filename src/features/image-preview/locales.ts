export const en = {
  title: "Image preview permissions", description: "Read-only image previews. These permissions do not grant file editing or model access.",
  file: "This image only", directory: "Images in this directory and its subdirectories",
  allowFile: "Preview only this image", allowDirectory: "Allow image previews in this directory",
  denied: "This image needs preview permission.", webDenied: "Allow image preview access in the desktop app.",
  loading: "Checking image scope…", granting: "Allowing preview…", error: "Could not update image preview permission. Check the scope again before approving.",
  scopeError: "Cannot inspect this image. It may be missing, unreadable, or unsupported.",
  empty: "No image preview permissions.", revoke: "Revoke", retry: "Retry", loadError: "Could not load image preview permissions.",
};
export const zh: typeof en = {
  title: "图片预览权限", description: "仅用于只读图片预览，不授予文件编辑或模型访问权限。",
  file: "仅这张图片", directory: "此目录及子目录中的图片",
  allowFile: "仅预览这张图", allowDirectory: "允许此目录图片预览",
  denied: "此图片需要预览授权。", webDenied: "请在桌面应用中授予图片预览权限。",
  loading: "正在核对图片范围…", granting: "正在授权预览…", error: "无法更新图片预览权限，请重新核对范围后再授权。",
  scopeError: "无法检查此图片，文件可能缺失、无法读取或格式不受支持。",
  empty: "尚无图片预览权限。", revoke: "撤销", retry: "重试", loadError: "无法加载图片预览权限。",
};
