
test('should have no 404s', () => {
  browserLogs.forEach((msg) => {
    expect(msg).not.toMatch('404')
  })
})

test('remote button', async () => {
  expect(
    await page.textContent('.remote-btn')
  ).toBe('React Button in vue')
})

