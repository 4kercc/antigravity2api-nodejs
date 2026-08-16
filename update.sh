#!/usr/bin/env bash

echo "========================================"
echo "Antigravity2API 更新脚本"
echo "========================================"
echo

echo "[1/3] 保存本地修改..."
git stash push -m "Auto stash before update"
if [ $? -ne 0 ]; then
    echo "保存修改失败"
    exit 1
fi

echo
echo "[2/3] 拉取最新代码 (分支: antigravity2api)..."
git pull origin antigravity2api
if [ $? -ne 0 ]; then
    echo "拉取更新失败"
    exit 1
fi

echo
echo "[3/3] 安装依赖..."
npm install

echo
echo "========================================"
echo "更新完成！"
echo "========================================"
echo
echo "恢复本地修改："
echo "  git stash pop"
echo
echo "删除本地修改："
echo "  git stash drop"
echo