// The "welcome back" lines Corvid posts on the board when the user opens the app (#122). Plain data, so they are
// easy to edit: scripts/test-welcome.mjs checks every line for length, crow-isms, emoji and forbidden content.
//
// {, name} becomes ", Robin" with a name set in Settings and nothing without one, so every line must read well both
// ways. `times` and `away` narrow when a line fits; a line with neither fits any open. Keep them short, warm and a
// bit funny, never at the user's expense and never nagging about how long they were gone.

export type TimeOfDay = 'morning' | 'afternoon' | 'evening' | 'late'
/** short: under a day, back the same day · newday: under a day, but the first open of the day · day: a day or two · week: three days or more */
export type Away = 'short' | 'newday' | 'day' | 'week'

export interface WelcomeLine {
  id: string
  text: string
  times?: TimeOfDay[]
  away?: Away[]
}

/** Crow office: one or two crow-isms at most, an emoji now and then (from BOARD_EMOJI, at most one). */
export const CROW_LINES: WelcomeLine[] = [
  { id: 'm1', text: 'Morning{, name}. The coffee is on and the perch is warm ☕', times: ['morning'] },
  { id: 'm2', text: 'Good morning{, name}! The flock is stretching its wings.', times: ['morning'] },
  { id: 'm3', text: 'Morning{, name}. First caw of the day goes to you.', times: ['morning'], away: ['newday', 'day', 'week'] },
  { id: 'm4', text: 'Rise and shine{, name}. The office smells of toast and feathers.', times: ['morning'] },
  { id: 'm5', text: 'Morning{, name}. I kept your seat by the window 🐦', times: ['morning'], away: ['newday', 'day'] },
  { id: 'a1', text: 'Afternoon{, name}. The roost is open for business.', times: ['afternoon'] },
  { id: 'a2', text: 'Good afternoon{, name}! Perfect weather for a swoop.', times: ['afternoon'] },
  { id: 'a3', text: 'Afternoon{, name}. Someone left biscuits by the perch, so that\'s nice.', times: ['afternoon'] },
  { id: 'a4', text: 'Hey{, name}, back for the afternoon shift? The flock approves.', times: ['afternoon'], away: ['short'] },
  { id: 'e1', text: 'Evening{, name}. The office lamps are on and the nest is cosy.', times: ['evening'] },
  { id: 'e2', text: 'Evening{, name}. The sky\'s gone orange and the flock\'s settling in 🍂', times: ['evening'] },
  { id: 'e3', text: 'Evening{, name}! Grab a snack, the roost is all yours.', times: ['evening'] },
  { id: 'e4', text: 'Evening shift{, name}? I\'ll fluff my feathers and keep you company.', times: ['evening'] },
  { id: 'l1', text: 'Burning the midnight oil{, name}? I\'ll keep a talon on the lights 🌙', times: ['late'] },
  { id: 'l2', text: 'Late one{, name}. The night owls are jealous of our roost.', times: ['late'] },
  { id: 'l3', text: 'Hello, night crow{, name}. Quiet office, good thinking time.', times: ['late'] },
  { id: 'l4', text: 'Still up{, name}? Me too. Crows keep odd hours 🌙', times: ['late'] },
  { id: 's1', text: 'Welcome back{, name}. The perch kept your spot warm.', away: ['short'] },
  { id: 's2', text: 'Back already{, name}? Good timing, the kettle just boiled ☕', away: ['short'] },
  { id: 's3', text: 'Oh hey{, name}, welcome back to the roost.', away: ['short'] },
  { id: 'd1', text: 'Welcome back{, name}! The flock saved you a shiny thing.', away: ['day'] },
  { id: 'd2', text: 'Good to see you{, name}. The nest stayed tidy, mostly.', away: ['day'] },
  { id: 'd3', text: 'Welcome back{, name}. I hoarded the good pens for you.', away: ['day'] },
  { id: 'w1', text: 'Look who swooped back in{, name}! Lovely to see you 🎉', away: ['week'] },
  { id: 'w2', text: 'Welcome back{, name}! The murder is glad you\'re here.', away: ['week'] },
  { id: 'w3', text: 'Hey{, name}, welcome back to the roost. I dusted the perches.', away: ['week'] },
  { id: 'g1', text: 'Welcome back{, name}. Caw, as we say in the office.' },
  { id: 'g2', text: 'Hey{, name}! The office is a little brighter now ✨' },
  { id: 'g3', text: 'Welcome back{, name}. Pull up a perch.' },
  { id: 'g4', text: 'There you are{, name}. The flock was hoping you\'d drop by.' }
]

/** Plain: friendly and brief, no crow talk, no emoji. */
export const PLAIN_LINES: WelcomeLine[] = [
  { id: 'pm', text: 'Good morning{, name}. Welcome back.', times: ['morning'] },
  { id: 'pa', text: 'Good afternoon{, name}. Welcome back.', times: ['afternoon'] },
  { id: 'pe', text: 'Good evening{, name}. Welcome back.', times: ['evening'] },
  { id: 'pl', text: 'Welcome back{, name}. Working late tonight?', times: ['late'] },
  { id: 'pg1', text: 'Welcome back{, name}.' },
  { id: 'pg2', text: 'Hi{, name}. Good to see you again.' }
]
