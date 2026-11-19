# AI 多窗口对话

## 使用方法

1. 安装 Node.js LTS（https://nodejs.org）
2. 双击 start.bat（首次会自动 npm install，使用国内镜像）
3. 在各面板里分别登录一次，之后自动保持登录
4. 模型：在各面板里用官网下拉菜单手动选择
5. 平台网址 / 输入框定位在 platforms.json 中修改

## 文件说明

- `main.js`：Electron 主进程，负责窗口、平台面板、提示词注入、模型菜单及本地设置。
- `preload.js`：通过受控 API 连接界面与主进程。
- `ui.html`：侧边栏、分屏布局、提示词输入及发送状态界面。
- `platforms.json`：配置平台网址、输入框、发送按钮、模型菜单和回答区域的选择器。
