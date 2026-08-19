# The Territory Model — build plan

City operators, each setting their own commission, with 30% flowing back to the
franchisor. Recorded here from the plan artifact so it lives with the code rather
than behind a link.

## Where the money moves

Nothing changes at the door: the customer pays the rider everything — goods,
delivery fee, store fee, convenience fee — exactly as before. What changes is
what happens behind the rider.

```
Customer ──everything──▶ Rider ──commission + mark-up──▶ City operator ──30%──▶ Franchisor
 pays at the door      fees less commission              keeps 70%          on settlement
```

Two ledgers, not one. The rider owes their city operator; the city operator owes
the franchisor. The rate is set per city, by its operator, inside a band the
franchisor sets.

**Book the 30% on confirmed settlement, not on delivery.** Riders do not always
settle on time, and a delivery-time royalty would invoice an operator 30% of
money that never reached them. It is painful to change later.

## The five rules

1. The royalty is on **all platform revenue** — commission plus the operator's
   share of any mark-up — not commission alone, or margin quietly shifts into
   mark-up.
2. It is booked **on confirmed settlement**, so the cut follows real money.
3. Commission rates have a **floor and a ceiling** the franchisor sets; operators
   move freely inside the band.
4. A delivery belongs to **the territory it was picked up in**, and drop-offs
   outside that territory's radius are refused.
5. **Only the franchisor opens or suspends a territory.** Suspending stops new
   orders without destroying history.

## Phases

| Phase | What | Size | State |
|---|---|---|---|
| 0 | Settle the rules of the franchise | — | Done |
| 1 | Territory as a first-class thing | Large | **Built** — see [territories.md](./territories.md) |
| 2 | The 30/70 split, in code | Large | **Built** — see [territories.md](./territories.md#the-royalty) |
| 3 | Put the brand on it | Small | Done — ServdGo naming, palette and icons |
| 4 | The Servd door — an API for restaurants to book deliveries | Medium | Not started |
| 5 | First city live | — | Operator's |

### Phase 2 — what was built

- A royalty ledger booking the franchisor's share when a rider's settlement is
  **confirmed**, with the rate snapshotted onto each entry
- An operator settlement flow: a period, an amount computed from the ledger, a
  method, a reference, and only the franchisor confirming it arrived
- A franchisor console: every city's volume, revenue, what each owes and who is
  behind, plus the rate and the commission band
- Operator onboarding and approval — a city cannot trade until it has an
  operator, a boundary and payout details, and only the franchisor opens it

**Still yours to do:** check the royalty maths against a worked example from a
real day before it goes near a live city. `supabase/tests/royalty.sql` proves
the rules hold; it cannot tell you the rules match the deal you are signing.

Two questions from Phase 0 remain open: whether operators pay a joining fee on
top of the share (the ledger has a `joining_fee` kind ready for one, so the
decision needs no code), and the domain.

## Two things that will bite later

- **The maps will not survive scale.** Both apps draw from OpenStreetMap's public
  tile servers, whose usage policy does not really cover commercial apps at
  volume. Budget for MapTiler or Mapbox before the second city opens.
- **Competing with yourself at home.** If the franchise brand and Easy Buy both
  operate in the same city, they draw from one pool of riders. Decide
  deliberately which brand owns the home city rather than discovering the answer
  when a rider has to pick.

## The fork

ServdGo is a copy of Easy Buy, not a shared codebase: its own repository, its own
Supabase project, its own Vercel projects. Easy Buy is never opened.

The bill for that is that fixes stop travelling — a bug fixed in one does not
reach the other, and the shared packages holding the fee, commission and
settlement maths are exactly where a missing fix hurts most. Cheap insurance:
keep Easy Buy attached as a second git remote so a fix can be carried across
deliberately, one commit at a time.

```
git remote add easybuy <easy-buy-repo-url>
git fetch easybuy
git cherry-pick <commit>
```
