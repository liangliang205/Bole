# 部署与运行

## 部署边界

本配置面向单机、单实例、可信 HR 管理员使用的生产部署。SQLite、本地文件和进程内 HITL 状态不支持简单地把应用横向扩容；不要设置多个 bole 副本，也不要让多台服务器共享 SQLite 卷。平台尚无应用内身份、角色权限或工具沙箱；共享网关账号不等于多租户隔离。完成后对话中的 Python 和已安装 MCP/Skill 可执行程序拥有应用用户的数据权限，只给受信任管理员开放。

生产主机建议 Linux，Docker Engine 与 Compose >= 2.24.4。当前项目直接运行 TypeScript，镜像使用 Node 24。2GB 内存是默认资源上限，不是已经压测的容量承诺；大量 OCR、Office 导出及并发筛选应根据实测调整。

## 本地与 Docker 启动

本机仍使用 `pnpm install`、`pnpm ocr:download`、`pnpm web`。Docker 默认只把应用发布到宿主机回环地址：

```bash
docker compose build --pull
docker compose up -d --wait
docker compose ps
curl --fail http://127.0.0.1:8787/readyz
```

镜像采用独立依赖阶段，只安装生产依赖。运行阶段使用 node 用户（UID/GID 1000），有 CA、Git、Python 3 和中日韩字体；并不包含所有 Python 数据科学库或平台之外的 CLI。OCR 数据在构建阶段下载到 /app/ocr，不会被数据卷遮盖。模型提供商 Key 首次从设置页面录入，加密保存在数据卷，不能把宿主机 data 目录打进镜像。

默认启用 init、只读根文件系统、可写 /tmp、能力移除、禁止提权、PID/内存/CPU 限制及日志轮转。`/app/data` 与 `/app/runs` 是可写持久卷，HOME、npm 缓存和邮件配置目录都位于 data 内。命名卷首次创建时继承镜像中的目录所有权；已有 root 所有的旧卷需在维护窗口按实际目录修复为 1000:1000，不能直接假定旧卷权限正确。不要挂载宿主机 Docker socket。

## HTTPS 与鉴权生产入口

先把真实域名的 DNS 指向部署主机，开放 TCP 80/443。自动证书申请需要访问证书服务。复制环境示例并生成密码哈希：

```bash
cp .env.production.example .env.production
docker run --rm -it caddy:2-alpine caddy hash-password
```

编辑 .env.production 的 BOLE_DOMAIN、BOLE_AUTH_USER、BOLE_AUTH_HASH。域名填写裸域名，例如 jobs.example.com。密码哈希用单引号包裹，避免 Compose 对 `$` 插值；不要使用示例占位哈希。该文件已经 gitignore，但仍需设置主机访问权限。

```bash
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.production.yml config --quiet
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.production.yml up -d --build --wait
```

生产覆盖配置会清除 bole 的宿主端口，只允许通过 Caddy 访问。Caddy 提供 TLS、Basic Auth、40MB 请求上限和实时 SSE 转发，并拒绝带不匹配 Origin 的浏览器写请求。需要企业 SSO/MFA 时，将 Basic Auth 替换为经过验证的身份网关，保持应用端口私有。外部请求未认证应返回 401，认证后才能访问页面；禁止仅凭容器健康就认为外部鉴权已验收。

健康检查 /healthz 表示 HTTP 进程存活；/readyz 在正常监听时返回 200，排空时返回 503。它们不调用模型或邮箱、不代表第三方服务或模型质量正常。Docker unhealthy 状态本身不会自动重启进程，需要监控告警；restart 策略只处理进程退出。

## 邮箱、插件与容器授权

通过输入框工具栏「招聘邮箱」切换简历来源，从侧栏邮箱面板配置适配器。评分标准和默认团队在设置中修改。其他 CLI 适配器的可执行程序必须实际安装在镜像中；宿主机 Windows 路径不能用于 Linux 容器，按需构建自定义镜像，不在运行中的只读根文件系统中临时 apt install。

内置 Agent Mail 的授权工作区固定为 codex，配置目录为 /app/data/mail-auth。容器中手动登录：

```bash
docker compose exec bole node node_modules/@tencent-qqmail/agently-cli/scripts/run.js auth login
docker compose exec bole node node_modules/@tencent-qqmail/agently-cli/scripts/run.js +me
```

使用生产覆盖文件时，所有 compose 命令应带上相同的 --env-file 和 -f 参数。Windows DPAPI 凭据不能直接迁移给 Linux，必须在目标运行环境重新授权；Linux keyring/CLI 持久化能力应在目标主机验收，不能只凭设置目录就假定重建后仍能登录。MCP/Skill 安装包及缓存保存在 data 中，但启动命令、平台二进制和外部依赖需要在目标镜像验证。

## 停止、升级和回滚

容器入口捕获 SIGTERM/SIGINT：先让 readiness 失败、拒绝新的写请求，再请求任务在检查点暂停，最长等待 60 秒，Compose 90 秒后才强制停止。之后关闭 SSE/HTTP 连接。超时或等待 HITL 时会保留已提交结果；普通人工问题在内存中，恢复后需重新触发。发信等外部副作用执行结果不确定时必须人工核对，禁止自动重放。

更新前安排维护窗口，处理人工问题并暂停筛选，然后备份。每次发布使用独立 BOLE_IMAGE 标签并记录镜像 digest、代码版本和工作流版本；示例 NODE_IMAGE/CADDY_IMAGE 使用可更新标签，正式发布应替换成审核过的 digest。当前工作流 1.5.0，执行代码改变时发布新工作流版本并保留旧镜像。不要通过覆盖数据库指纹绕过版本检查。

```bash
# 使用唯一发布标签，例如 bole:2026-11-07.1
# 修改环境文件后构建、启动；基础镜像更新也应重新验收。
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.production.yml build --pull
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.production.yml up -d --no-build --wait
```

回滚时使用原镜像及匹配的数据备份。数据库迁移不承诺向后兼容，不能只切旧镜像并复用已升级数据库。不要在仍有旧工作流运行时无计划地覆盖它所依赖的镜像。

## 一致性备份与恢复

不能在 SQLite 正在写入时直接分别复制 db、wal、shm。提供的 Linux 主机脚本会停止应用，打包完整 data 与 runs（包括密钥、知识库、简历、插件与邮箱配置），计算 SHA-256，最后恢复先前运行状态。关闭网关并非必须，但停机期间请求会失败；应安排维护窗口。

```bash
bash scripts/backup.sh --env-file .env.production -f docker-compose.yml -f docker-compose.production.yml
sha256sum -c backups/bole-时间戳.tgz.sha256
```

备份含敏感简历和解密密钥，应另行加密并复制到受控异地存储。环境文件、镜像 digest 和部署配置另行备份；caddy-data 保存证书账号，需纳入主机/卷备份策略。不要使用 `docker compose down -v`，该命令会删除数据卷。

恢复演练使用新的 Compose 项目和空卷，避免覆盖唯一生产数据。先校验可信备份，核对 tar 中仅有 data/ 和 runs/，再在匹配版本镜像下恢复：

```bash
# 先在隔离环境准备好匹配镜像；恢复到新项目的空卷。
docker compose -p bole-restore create bole
docker compose -p bole-restore run --rm --no-deps --user 0:0 --entrypoint sh -v "$PWD/backups:/backup:ro" bole -ec 'tar -xzf /backup/已校验的备份.tgz -C /app'
# 原服务占用 8787 时先设置 BOLE_PORT=8789，再启动恢复实例进行验收。
BOLE_PORT=8789 docker compose -p bole-restore up -d --wait
```

验证模型 Key 可解密、知识库/历史报告可读、邮箱可用，再决定切流。恢复实例不要同时执行生产筛选或发信。备份保留期、加密、异地复制和定时执行由部署方配置，脚本不会自动删除备份。

## 运维与验证

`docker compose logs --tail=200 bole` 查看运行日志，`docker stats` 观察内存/PID/CPU，监控磁盘空间、备份年龄、HTTP 5xx 和证书状态。数据卷达到容量上限时应停止新任务，先扩容或按保留策略清理，不直接删除 SQLite WAL。长时间任务和 SSE 需要网关与上游负载均衡器具备匹配的空闲超时。

`.github/workflows/docker.yml` 在 Linux 构建真实镜像，检查非 root 身份、只读运行、卷写入、健康状态、停止退出码、生产端口隔离及 Caddy 配置。应用检查使用 `pnpm check`。本次本机 Docker 引擎未运行，因此不能声称本机完成了构建、TLS、重启持久化、Office/OCR 或备份恢复实测；上线前需通过 CI 并在目标主机执行这些验收。

参考：[Compose 合并规则](https://docs.docker.com/compose/how-tos/multiple-compose-files/merge/)、[Compose 服务配置](https://docs.docker.com/reference/compose-file/services/)、[Caddy Basic Auth](https://caddyserver.com/docs/caddyfile/directives/basic_auth)。
