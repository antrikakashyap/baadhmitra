import { describe, expect, it } from 'vitest'
import { rulex } from '../shared/extract'

// Everyday Hindi/Hinglish wording for each need, with sentences that are not from any benchmark file.
const cases: [string, string[]][] = [
  ['nao chahiye jaldi, gaon me paani bhar gaya', ['boat']],
  ['bachche bhookhe hain, kal se kuch nahi khaya', ['food']],
  ['doodh nahi mil raha chhote bachche ke liye', ['food']],
  ['saf paani chahiye, handpump dub gaya', ['water']],
  ['peene layak paani nahi bacha', ['water']],
  ['dada ji bimar hain, ambulance nahi aa rahi', ['medical']],
  ['wo behosh ho gaye hain', ['medical']],
  ['rehne ke liye jagah nahi hai, bahar so rahe hain', ['shelter']],
  ['hum khule aasman ke neeche hain', ['shelter']],
  ['paani bhar gaya hai gali me', []], // no need stated
]

describe('need vocabulary', () => {
  it.each(cases)('%s', (text, want) => {
    expect(rulex(text).needs.sort()).toEqual([...want].sort())
  })
})
