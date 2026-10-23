#!/usr/bin/env node
/**
 * 通过 GitHub REST API 推送本地 HEAD 提交（github.com:443 不可达时的应急路径）。
 *
 * 只做一件事：把当前 HEAD 里改动的文件作为 blob 上传，建 tree/commit，移动分支引用；
 * 然后用同一份 author/committer 信息在本地重建 commit 对象，让本地 ref 与远端 sha 一致，
 * 避免下次网络恢复时出现分叉。
 *
 * 用法：TOKEN=xxx node scripts/push-via-api.js [branch]
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const OWNER = 'dh8818';
const REPO = 'yizhi';
const BRANCH = process.argv[2] || 'main';
const TOKEN = process.env.TOKEN;

if (!TOKEN) {
  console.error('需要 TOKEN 环境变量');
  process.exit(1);
}

const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
process.chdir(repoRoot);

function git(args) {
  return execSync(`git ${args}`, { encoding: 'utf8' }).trim();
}

async function api(p, opts) {
  const res = await fetch(`https://api.github.com${p}`, Object.assign(
    {
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'user-agent': 'yizhi-push-script',
        accept: 'application/vnd.github+json',
        'content-type': 'application/json'
      }
    },
    opts || {}
  ));
  const text = await res.text();
  if (!res.ok) throw new Error(`${p} → ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

function isoToGitDate(iso) {
  // 2026-10-23T07:45:00Z → 1761205500 +0000
  const d = new Date(iso);
  const ts = Math.floor(d.getTime() / 1000);
  return `${ts} +0000`;
}

(async () => {
  const headSha = git('rev-parse HEAD');
  const message = execSync('git log -1 --format=%B', { encoding: 'utf8' });
  // 必须用 git 里的 blob 内容（已按 .gitattributes 归一化），不能读工作区文件：
  // Windows 工作区是 CRLF，直接上传会让远端文件与 git blob 不一致。
  const files = (process.env.FILES ? process.env.FILES.split(',') : git('diff-tree --no-commit-id --name-only -r HEAD').split('\n')).filter(Boolean);

  console.log(`本地 HEAD ${headSha}`);
  console.log(`变更文件 ${files.length} 个：${files.join(', ')}`);

  const ref = await api(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
  const parentSha = ref.object.sha;
  const parentCommit = await api(`/repos/${OWNER}/${REPO}/git/commits/${parentSha}`);
  console.log(`远端 ${BRANCH} ${parentSha}`);

  const tree = [];
  for (const f of files) {
    // 用 blob 而不是工作区文件（换行已归一化，避免 CRLF 污染远端）
    let content;
    try {
      content = execSync(`git cat-file blob HEAD:${f}`, { maxBuffer: 64 * 1024 * 1024 });
    } catch (err) {
      throw new Error(`无法读取 HEAD:${f}（删除类提交请手工处理）`);
    }
    const blob = await api(`/repos/${OWNER}/${REPO}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: content.toString('base64'), encoding: 'base64' })
    });
    tree.push({ path: f, mode: '100644', type: 'blob', sha: blob.sha });
    console.log(`  blob ${f} → ${blob.sha.slice(0, 8)}`);
  }

  const newTree = await api(`/repos/${OWNER}/${REPO}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: parentCommit.tree.sha, tree })
  });

  const commit = await api(`/repos/${OWNER}/${REPO}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message, tree: newTree.sha, parents: [parentSha] })
  });
  console.log(`远端新提交 ${commit.sha}`);

  await api(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: false })
  });
  console.log(`已移动 ${BRANCH} → ${commit.sha}`);

  // 在本地重建同一个 commit 对象，避免分叉
  const authorDate = isoToGitDate(commit.author.date);
  const committerDate = isoToGitDate(commit.committer.date);
  const body = commit.message.endsWith('\n') ? commit.message : commit.message + '\n';
  const raw =
    `tree ${commit.tree.sha}\n` +
    `parent ${parentSha}\n` +
    `author ${commit.author.name} <${commit.author.email}> ${authorDate}\n` +
    `committer ${commit.committer.name} <${commit.committer.email}> ${committerDate}\n` +
    `\n${body}`;

  const localSha = execSync('git hash-object -t commit -w --stdin', { input: raw, encoding: 'utf8' }).trim();
  if (localSha === commit.sha) {
    execSync(`git update-ref refs/heads/${BRANCH} ${localSha}`);
    console.log(`本地 ref 已对齐：${BRANCH} → ${localSha}`);
  } else {
    console.log(`⚠ 本地重建 sha 不一致（${localSha} ≠ ${commit.sha}）`);
    console.log('  远端已是目标内容；网络恢复后执行：git fetch origin && git reset --mixed origin/' + BRANCH);
  }
})();
