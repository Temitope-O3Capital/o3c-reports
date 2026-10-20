/**
 * The two companions.
 *
 * Staff pick one and keep it. Two rather than one because a single default would
 * have been chosen for everyone by whoever wrote this file, and an assistant that
 * sits in the corner of the screen all day is a thing people should get a say in.
 *
 * Both are Nigerian, dark-skinned and in their twenties, which is what the people
 * using this workspace mostly are.
 *
 * WHAT A PERSONA MAY AND MAY NOT CHANGE
 *
 * `manner` reaches the model as a system-prompt fragment, so it is worth being
 * exact about its limits. It may change the ORDER things are said in, how much is
 * volunteered, and how a sentence is phrased. It may NOT change a figure, a
 * conclusion, or whether something is checked.
 *
 * That line matters more here than in most products. This assistant answers from
 * live collections, lending and card data, and two colleagues asking the same
 * question through different companions must get the same numbers. A persona that
 * genuinely "reasoned differently" would mean the answer depended on which face
 * you picked, which is indefensible in a bank. Tone is the variable; arithmetic
 * is not.
 */

export type CompanionId = 'esther' | 'temitope'

export type CompanionLook = {
  skin: string
  skinShade: string
  hair: string
  lip: string
  /** Drives which hair path is drawn. Kept as a name, not geometry, so the two
   *  silhouettes can be told apart in a prop list. */
  hairStyle: 'afro' | 'fade'
  /** Stud colour. Omitted for characters who wear none. */
  earring?: string
}

export type CompanionVoice = {
  /**
   * Piper voice model.
   *
   * THESE ARE BRITISH, AND THE CHARACTERS ARE NOT. Piper publishes English voices
   * for en_GB and en_US only - there is no Nigerian English voice in the set, and
   * an earlier version of this file invented one. British is the closest honest
   * fit, since Nigerian English is non-rhotic and British-derived, but nobody
   * should be surprised when Esther sounds like she is from Surrey.
   *
   * A genuinely Nigerian voice needs one of: a cloud service (Azure does publish
   * en-NG-EzinneNeural and en-NG-AbeoNeural, but that sends text off-site and this
   * VM has no egress), or training a Piper voice from recordings of a real
   * speaker, which needs a GPU and an hour or two of clean audio.
   */
  piper: string
  /** Browser-speech fallback hints, used until Piper is installed. */
  rate: number
  pitch: number
}

export type Persona = {
  id: CompanionId
  name: string
  /** Shown under the name in the panel header. */
  blurb: string
  pronoun: 'she' | 'he'
  look: CompanionLook
  voice: CompanionVoice
  /** System-prompt fragment. Tone only — see the note at the top of this file. */
  manner: string
  /** Said when strolling, and only when there is nothing more useful to say. */
  idleLines: string[]
}

export const COMPANIONS: Record<CompanionId, Persona> = {
  esther: {
    id: 'esther',
    name: 'Esther',
    blurb: 'Careful and thorough',
    pronoun: 'she',
    look: {
      skin: '#54331E',
      skinShade: '#412617',
      hair: '#120C08',
      lip: '#7A3B33',
      hairStyle: 'afro',
      earring: '#D8B25A',
    },
    voice: { piper: 'en_GB-cori-medium', rate: 0.96, pitch: 1.06 },
    manner: [
      'You are Esther. You lead with what the figure is, then immediately say what it',
      'does not cover — the date range, the exclusions, the rows that were null.',
      'When a number looks unusual against the rest of the answer you say so rather',
      'than letting it pass. When a question could mean two things you ask which,',
      'instead of picking one and answering confidently.',
      'You are warm but you do not pad: no "great question", no closing offers of',
      'further help.',
    ].join(' '),
    idleLines: [
      'Still here if you need a figure.',
      'I can pull collections, lending, cards or call volume.',
    ],
  },

  temitope: {
    id: 'temitope',
    name: 'Temitope',
    blurb: 'Direct and quick',
    pronoun: 'he',
    look: {
      skin: '#4E2F1B',
      skinShade: '#3B2314',
      hair: '#0F0A07',
      lip: '#6B3429',
      hairStyle: 'fade',
    },
    voice: { piper: 'en_GB-alan-medium', rate: 1.04, pitch: 0.94 },
    manner: [
      'You are Temitope. You answer the question asked in the first sentence, with the',
      'number in it, then give the detail underneath. You keep it short.',
      'After answering you offer the one obvious next question a person would have',
      'asked — only when there plainly is one, and never more than one.',
      'You do not hedge for the sake of it, but if the data cannot answer something',
      'you say that plainly in one line rather than approximating.',
    ].join(' '),
    idleLines: [
      'Need a number? Ask away.',
      'I can check the book, the queue or the calls.',
    ],
  },
}

export const DEFAULT_COMPANION: CompanionId = 'esther'

const KEY = 'o3c_companion'

export function readCompanion(): CompanionId {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'esther' || v === 'temitope') return v
  } catch {
    // Private window, or site data blocked. Falling through to the default is
    // correct: the choice is a convenience, not something to fail an app over.
  }
  return DEFAULT_COMPANION
}

export function writeCompanion(id: CompanionId) {
  try { localStorage.setItem(KEY, id) } catch { /* see readCompanion */ }
}

/** Has the person ever been asked which one they want? */
export function companionChosen(): boolean {
  try { return localStorage.getItem(KEY) !== null } catch { return false }
}

const ROAM_KEY = 'o3c_companion_roam'

/**
 * Whether the companion may appear outside the panel.
 *
 * Defaults to OFF. Something that moves across the screen unbidden has to be opted
 * into by the person it will interrupt — staff here are on calls and in the middle
 * of reconciliations, and a surprise is a cost, not a delight.
 */
export function roamEnabled(): boolean {
  try { return localStorage.getItem(ROAM_KEY) === '1' } catch { return false }
}

export function setRoamEnabled(on: boolean) {
  try { localStorage.setItem(ROAM_KEY, on ? '1' : '0') } catch { /* see readCompanion */ }
}

export function personaOf(id: CompanionId): Persona {
  return COMPANIONS[id] ?? COMPANIONS[DEFAULT_COMPANION]
}

export function greeting(p: Persona, now = new Date()): string {
  const h = now.getHours()
  const part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
  return `${part} — ${p.name} here. Ask me anything about the workspace.`
}
