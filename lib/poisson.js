'use strict';

function factorial(n) {
  let r = 1; for (let i = 2; i <= n; i++) r *= i; return r;
}

function poissonProb(lambda, k) {
  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k);
}

function calcGoalProbs(homeAttack, homeDefense, awayAttack, awayDefense, leagueAvgGoals = 1.35) {
  const homeExpG = Math.max(0.3, homeAttack * awayDefense * leagueAvgGoals);
  const awayExpG = Math.max(0.3, awayAttack * homeDefense * leagueAvgGoals);

  const probs = {};
  for (let h = 0; h <= 6; h++) {
    for (let a = 0; a <= 6; a++) {
      probs[`${h}-${a}`] = poissonProb(homeExpG, h) * poissonProb(awayExpG, a);
    }
  }

  const overX = (line) => Object.entries(probs)
    .filter(([s]) => { const [h,a] = s.split('-').map(Number); return h+a > line; })
    .reduce((s, [,p]) => s + p, 0);

  const bttsYes = Object.entries(probs)
    .filter(([s]) => { const [h,a] = s.split('-').map(Number); return h>0 && a>0; })
    .reduce((s, [,p]) => s + p, 0);

  return {
    homeExpG: +homeExpG.toFixed(2),
    awayExpG: +awayExpG.toFixed(2),
    over15: +overX(1.5).toFixed(4),
    over25: +overX(2.5).toFixed(4),
    over35: +overX(3.5).toFixed(4),
    bttsYes: +bttsYes.toFixed(4),
    bttsNo:  +(1 - bttsYes).toFixed(4),
  };
}

module.exports = { factorial, poissonProb, calcGoalProbs };
