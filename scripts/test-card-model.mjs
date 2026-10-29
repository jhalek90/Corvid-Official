// Tests for #234, the model tag on an agent's card: each model's short name, 'default' resolved to the Claude Code
// default when it's known (then the model the session replied with, else just "Default"), a task's own model beating
// the worker model from Settings, and sessions Corvid didn't start showing a model only when their replies name one.
// Pure functions from src/shared/models.ts; nothing is started.
//
//   npm run test-card-model

import { register } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// load .ts as ES modules, like the other tests' loaders
register(
  'data:text/javascript,' +
    encodeURIComponent(`export async function resolve(s, c, next) {
      // models.ts imports ./reasoningEffort (#238) without an extension, as src/shared does
      if (s.startsWith('./') && c.parentURL?.endsWith('.ts') && !/\\.[a-z]+$/.test(s)) return next(s + '.ts', c)
      return next(s, c)
    }
    export async function load(u, c, next) {
      return /\\.ts(?:\\?|$)/.test(u) ? next(u, { ...c, format: 'module-typescript' }) : next(u, c)
    }`)
)
const { cardModel, taskModel } = await import(pathToFileURL(join(import.meta.dirname, '..', 'src', 'shared', 'models.ts')).href)
const label = (...a) => cardModel(...a)?.label

test('each model gets its short name and family', () => {
  assert.deepEqual(cardModel('haiku'), { label: 'Haiku', family: 'haiku' })
  assert.deepEqual(cardModel('sonnet'), { label: 'Sonnet', family: 'sonnet' })
  assert.deepEqual(cardModel('opus'), { label: 'Opus', family: 'opus' })
  assert.deepEqual(cardModel('fable'), { label: 'Fable', family: 'fable' })
  // a full id, as a hand-edited record or an older one might hold
  assert.equal(label('claude-opus-5-5[1m]'), 'Opus')
})

test("'default' shows the Claude Code default when it's known", () => {
  assert.deepEqual(cardModel('default', 'opus[1m]'), { label: 'Opus', family: 'opus' })
  assert.equal(label('default', 'claude-sonnet-5-5'), 'Sonnet')
  assert.equal(cardModel('default', 'fable').family, 'fable')
  // the settings name a model, so the session's replies don't matter
  assert.equal(label('default', 'haiku', { 'claude-opus-5-5': 9 }), 'Haiku')
})

test("'default' falls back to the session's model, then to plain \"Default\"", () => {
  assert.equal(label('default', undefined, { 'claude-sonnet-5-5': 3, 'claude-haiku-5-5': 1 }), 'Sonnet')
  assert.deepEqual(cardModel('default'), { label: 'Default', family: 'other' })
  assert.deepEqual(cardModel('default', 'something-new', {}), { label: 'Default', family: 'other' })
})

test("a task's own model beats the Settings worker model on the card", () => {
  // the worker record holds taskModel(task, Settings), as workers.ts starts it
  assert.equal(label(taskModel({ model: 'haiku' }, 'opus'), 'sonnet'), 'Haiku')
  assert.equal(label(taskModel({ model: 'fable' }, 'default'), 'sonnet'), 'Fable')
  assert.equal(label(taskModel({}, 'default'), 'sonnet'), 'Sonnet')
  assert.equal(label(taskModel(undefined, 'opus')), 'Opus')
})

test("a session Corvid didn't start shows its replies' model, or nothing", () => {
  assert.equal(label(undefined, 'opus', { '<synthetic>': 50, 'claude-haiku-5-5': 2 }), 'Haiku')
  assert.equal(cardModel(undefined, 'opus'), undefined)
  assert.equal(cardModel(undefined, 'opus', {}), undefined)
  assert.equal(cardModel(undefined, undefined, { '<synthetic>': 1 }), undefined)
})

// #316: one of the user's own models shows its entry's label everywhere a model is named
const { choiceLabel, displayModel } = await import(pathToFileURL(join(import.meta.dirname, '..', 'src', 'shared', 'models.ts')).href)
const own = [{ id: 'qwen-local', label: 'Qwen 27B (local)', kind: 'anthropic', baseUrl: 'http://localhost:8080', model: 'qwen-gguf', contextTokens: 32768 }]

test("a custom model's card, selector and display name are its entry's label", () => {
  assert.deepEqual(cardModel('custom:qwen-local', 'opus', {}, own), { label: 'Qwen 27B (local)', family: 'other', custom: true })
  assert.equal(choiceLabel('custom:qwen-local', own), 'Qwen 27B (local)')
  assert.equal(displayModel('custom:qwen-local', own), 'Qwen 27B (local)')
  // a transcript names the server's model; that shows the label too
  assert.equal(displayModel('qwen-gguf', own), 'Qwen 27B (local)')
  // an entry that's gone says so, and Claude models are unchanged
  assert.equal(choiceLabel('custom:qwen-local'), 'qwen-local (removed)')
  assert.equal(cardModel('custom:gone', undefined, undefined, own).label, 'gone (removed)')
  assert.equal(choiceLabel('opus', own), 'Opus')
  assert.equal(displayModel('claude-opus-5-5', own), 'Opus 5.5')
  assert.deepEqual(cardModel('haiku', undefined, undefined, own), { label: 'Haiku', family: 'haiku' })
})
