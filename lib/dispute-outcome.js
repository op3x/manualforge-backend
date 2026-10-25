// Whether a closed dispute gives the purchase back. Inquiry (`warning_closed`)
// and `prevented` are not a win. That choice is still open, so this stays
// true only for `won`. Callers must not restore access for any other status.

function restoresAccess(status) {
  return status === 'won';
}

module.exports = {
  restoresAccess,
};
