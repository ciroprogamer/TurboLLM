// ADR-444: Jev and Laya share the name "Text classification"; a row still says which runtime serves the model.
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TextClassificationRuntimeLabel } from './TextClassificationRuntimeLabel'
import type { JevInfo } from '../lib/types'

const JEV_INFO: JevInfo = {
  labels: ['contradiction', 'entailment', 'neutral'],
  nliTemplate: null,
  architecture: 'Qwen3_5ForSequenceClassification',
  verified: true,
}

describe('TextClassificationRuntimeLabel', () => {
  it('says vLLM for a Jev model', () => {
    render(<TextClassificationRuntimeLabel model={{ jev: JEV_INFO }} />)
    expect(screen.getByText('vLLM')).toBeTruthy()
  })

  it('says the Laya engine for a Laya model', () => {
    render(<TextClassificationRuntimeLabel model={{ laya: { checkpoints: ['english'] } }} />)
    expect(screen.getByText('Laya engine')).toBeTruthy()
  })

  it('is nothing for a chat model', () => {
    const { container } = render(<TextClassificationRuntimeLabel model={{}} />)
    expect(container).toBeEmptyDOMElement()
  })
})
