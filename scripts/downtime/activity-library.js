/** Original guided activities; narrative benefits are awarded by the GM. */
export const ADDITIONAL_GUIDED_ACTIVITIES = Object.freeze([
  {
    id: "guided-performance",
    name: "Perform for a Crowd",
    description:
      "Entertain an audience with music, stories, acrobatics, or stagecraft. Earn tips and a reputation; the GM decides who notices.",
    image: "icons/svg/sound.svg",
    skills: ["prf", "acr", "per"],
    outcomes: [
      {
        label: "A quiet audience",
        report:
          "The crowd was small. You learned which parts of your act need work, but collected no tips.",
        rewardGp: 0,
      },
      {
        label: "A good show",
        report:
          "Your performance held the crowd and earned a modest collection of tips.",
        rewardGp: 2,
      },
      {
        label: "An encore",
        report:
          "The audience called for more. You earned generous tips and an invitation to perform again.",
        rewardGp: 4,
      },
    ],
  },
  {
    id: "guided-training",
    name: "Train & Spar",
    description:
      "Practice footwork, endurance, or technique with a willing partner or instructor. Instruction costs 1 gp per workday. The GM records progress; this does not automatically grant proficiency or combat bonuses.",
    image: "icons/svg/combat.svg",
    skills: ["ath", "acr", "ins"],
    work: { output: "none", gpPerDay: 1 },
    outcomes: [
      {
        label: "Find your limits",
        report:
          "Practice exposed a weak point in your technique. You leave with a specific exercise to work on.",
        rewardGp: 0,
      },
      {
        label: "Steady improvement",
        report:
          "You corrected a recurring mistake. Your partner recognizes the improvement and offers another practice session.",
        rewardGp: 0,
      },
      {
        label: "A lesson clicks",
        report:
          "A difficult technique finally makes sense. Your instructor suggests a new challenge; the GM records any agreed training milestone.",
        rewardGp: 0,
      },
    ],
  },
  {
    id: "guided-contacts",
    name: "Build Local Contacts",
    description:
      "Meet people, exchange introductions, and learn whom to approach for help. Hospitality costs 1 gp per workday. The GM names any new contact and the limits of their assistance.",
    image: "icons/svg/coins.svg",
    skills: ["per", "ins", "dec"],
    work: { output: "none", gpPerDay: 1 },
    outcomes: [
      {
        label: "Introductions only",
        report:
          "You put names to faces, but nobody is ready to vouch for you yet. One conversation is worth following up.",
        rewardGp: 0,
      },
      {
        label: "A friendly face",
        report:
          "You made a useful acquaintance. The GM identifies the contact and one kind of information or introduction they can offer.",
        rewardGp: 0,
      },
      {
        label: "Someone in your corner",
        report:
          "You earned a promising introduction and an offer of modest help. The GM names the contact, their terms, and any favor owed.",
        rewardGp: 0,
      },
    ],
  },
  {
    id: "guided-scouting",
    name: "Scout & Map",
    description:
      "Survey nearby paths, landmarks, tracks, and hazards around camp or a settlement. Bring your findings back to the party; the GM supplies the actual discoveries.",
    image: "icons/svg/direction.svg",
    skills: ["sur", "prc", "nat"],
    outcomes: [
      {
        label: "Incomplete notes",
        report:
          "Poor visibility or difficult ground limited your survey. You identified one area that needs a closer look.",
        rewardGp: 0,
      },
      {
        label: "A useful route",
        report:
          "You returned with useful notes on a local route or hazard. The GM describes what the party can now plan around.",
        rewardGp: 0,
      },
      {
        label: "An overlooked detail",
        report:
          "Your survey revealed an overlooked trail, sign of activity, or sheltered stopping place. The GM adds the discovery to your report.",
        rewardGp: 0,
      },
    ],
  },
  {
    id: "guided-care",
    name: "Tend the Sick",
    description:
      "Assist a healer, prepare clean dressings, and care for people who need help. Supplies cost 0.5 gp per workday. The GM decides any recovery; no HP, conditions, or injuries change automatically.",
    image: "icons/svg/heal.svg",
    skills: ["med", "nat", "ins"],
    work: { output: "none", gpPerDay: 0.5 },
    outcomes: [
      {
        label: "Comfort and care",
        report:
          "You kept patients comfortable and relieved an overworked caregiver. More skilled treatment is still needed.",
        rewardGp: 0,
      },
      {
        label: "Practical help",
        report:
          "Your careful assistance made a difficult day easier. A grateful patient or healer offers a useful local introduction.",
        rewardGp: 0,
      },
      {
        label: "Trusted hands",
        report:
          "You noticed an important detail and earned the healer's trust. The GM describes any improvement and who will remember your help.",
        rewardGp: 0,
      },
    ],
  },
  {
    id: "guided-service",
    name: "Religious Service",
    description:
      "Help maintain a shrine, assist a ceremony, or serve a religious community. Discuss the tradition with the GM; any blessing or favor is a story outcome chosen during review.",
    image: "icons/svg/angel.svg",
    skills: ["rel", "ins", "per"],
    outcomes: [
      {
        label: "Humble service",
        report:
          "You completed the unglamorous work that keeps the community going and learned more about its customs.",
        rewardGp: 0,
      },
      {
        label: "A warm welcome",
        report:
          "Your service was appreciated. A member of the community offers conversation, guidance, or an introduction chosen by the GM.",
        rewardGp: 0,
      },
      {
        label: "A matter of trust",
        report:
          "Your dedication earned a trusted audience. The GM describes a meaningful piece of guidance or a request for further service.",
        rewardGp: 0,
      },
    ],
  },
  {
    id: "guided-animal-care",
    name: "Care for Animals",
    description:
      "Groom mounts, inspect tack, settle nervous animals, or practice familiar commands. Work with animals already available to you; the GM decides changes in trust or training.",
    image: "icons/svg/pawprint.svg",
    skills: ["ani", "med", "nat"],
    outcomes: [
      {
        label: "Patient routine",
        report:
          "Feeding, grooming, and patient handling kept the animals comfortable. Training will take more time.",
        rewardGp: 0,
      },
      {
        label: "Growing trust",
        report:
          "An animal became more comfortable with your handling. You also spotted a practical care issue before it became a problem.",
        rewardGp: 0,
      },
      {
        label: "A promising bond",
        report:
          "Consistent handling paid off. The GM records progress toward an agreed command or a stronger bond with the animal.",
        rewardGp: 0,
      },
    ],
  },
  {
    id: "guided-reflection",
    name: "Rest & Reflect",
    description:
      "Take quiet time to journal, meditate, or talk through recent events. No roll or fee. Agree on a personal takeaway with the GM; this does not automatically apply rest benefits or remove conditions.",
    image: "icons/svg/sleep.svg",
    skills: [],
    outcomes: [
      {
        label: "A quiet pause",
        report:
          "You gave yourself time to breathe and put recent events into words. Some questions can wait until tomorrow.",
        rewardGp: 0,
      },
      {
        label: "A clearer purpose",
        report:
          "Reflection helped you name a priority, concern, or promise that will guide your next decision.",
        rewardGp: 0,
      },
      {
        label: "A personal resolution",
        report:
          "You reached a meaningful personal decision. Record the bond, intention, or unfinished conversation you want to explore next.",
        rewardGp: 0,
      },
    ],
  },
]);
