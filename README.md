# 个人图片生成手机版

这是从“社群专用图片生成”拆出来的独立个人版项目，专门适配手机网页。它不依赖原项目的前端、账号数据和运行数据。

## 功能

- 手机优先界面：提示词、案例、上传底图、比例、结果、任务和最近图片在一个轻量页面里完成。
- 支持从 0 生成图片，也支持上传最多 4 张底图进行修改，底图支持 PNG、JPG/JPEG、WEBP、HEIC/HEIF；HEIC/HEIF 会按约 384KB 分片上传，并在服务端后台转成 JPG，提交修改任务时只传图片编号。
- 默认管理员登录，并支持在后台新增、修改普通用户。
- 普通用户不显示 API Key、接口地址和模型设置，只使用管理员配置好的服务端图片接口。
- 页面底部账号栏会显示服务端版本和网页端版本，便于确认手机端是否已经加载新版资源。
- 任务后台执行，刷新页面后可看最近任务和最近图片。
- 默认端口 `4273`，避免和原项目 `4173` 冲突。

## 本地运行

```bash
npm start
```

访问地址：`http://127.0.0.1:4273/`

默认管理员登录：

- 账号：`personal`
- 密码：`personal123456`

建议正式使用时配置环境变量：

```bash
APP_USERNAME=管理员账号 APP_PASSWORD=管理员密码 NEWAPI_API_KEY=你的key npm start
```

管理员登录后可以在“用户管理”里新增或修改用户。普通用户如果要生成图片，需要管理员提前通过 `NEWAPI_API_KEY` 配好服务端 API Key。

## 爱快 Docker 部署

项目已经内置 `Dockerfile` 和 `docker-compose.yml`。容器内使用 `/data` 保存登录会话、用户、任务记录和生成图片，部署时需要挂载出来。

GitHub 镜像发布后，可以直接使用：

```bash
docker pull ghcr.io/huge1818666/personal-mobile-image-generator:latest
```

GitHub Actions 也会同时发布带网页版本号的镜像标签和离线包文件名，例如 `web-v0.1.5`，方便确认爱快里导入的是哪一版。

如果爱快支持 Compose，可以参考：

```bash
docker compose up -d --build
```

如果用爱快 Docker 图形界面创建容器，参数按下面填：

- 镜像：先用 `docker build -t personal-mobile-image-generator:latest .` 构建，或把镜像导入爱快后选择它。
- 容器端口：`4273`
- 主机端口：`4273`
- 挂载目录：宿主机目录 `/你的持久化目录/personal-image-data` 挂载到容器 `/data`
- 重启策略：`unless-stopped` 或“总是重启”
- 环境变量：至少设置 `HOST=0.0.0.0`、`PORT=4273`、`DATA_DIR=/data`、`APP_USERNAME`、`APP_PASSWORD`、`NEWAPI_API_KEY`

浏览器访问：

```text
http://爱快IP:4273/
```

## 文件说明

- `server.mjs`：独立 HTTP 服务、登录会话、任务和最近图片接口。
- `image-api.mjs`：图片生成和底图修改 API 调用，复制自原项目并独立使用。
- `public/`：手机网页端。
- `.personal-data.json`：运行时任务和图片记录，已加入 `.gitignore`。
