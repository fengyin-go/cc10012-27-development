# syntax=docker/dockerfile:1

# ===== 构建阶段：安装依赖、跑缓存测试、产出静态产物 =====
FROM node:20-alpine AS build
WORKDIR /srv/web
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY . .
# 命中结果记录集相关测试与类型检查随镜像构建一起验证；内存驱动做无头兜底。
ENV VITE_CACHE_DRIVER=auto
RUN npm run verify

# ===== 运行阶段：静态托管生产产物，本地开发兜底保留 dev 目标 =====
FROM node:20-alpine AS runtime
WORKDIR /srv/web
COPY --from=build /srv/web/dist ./dist
# 零额外依赖的静态服务器：SPA 路由回退到 index.html。
COPY --from=build /srv/web/package.json ./package.json
RUN printf '%s\n' \
  "const http=require('http'),fs=require('fs'),path=require('path');" \
  "const root=path.join(process.cwd(),'dist'),port=process.env.PORT||5173;" \
  "const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'};" \
  "http.createServer((req,res)=>{" \
  " let p=decodeURIComponent(req.url.split('?')[0]);let f=path.join(root,p);" \
  " if(!f.startsWith(root)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){f=path.join(root,'index.html');}" \
  " res.setHeader('Content-Type',types[path.extname(f)]||'application/octet-stream');" \
  " fs.createReadStream(f).pipe(res);" \
  "}).listen(port,()=>console.log('static server on '+port));" \
  > server.js
EXPOSE 5173
CMD ["node", "server.js"]

# ===== 本地开发兜底：docker build --target development 时启用热更新 dev server =====
FROM node:20-alpine AS development
WORKDIR /srv/web
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
ENV VITE_CACHE_DRIVER=auto
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
