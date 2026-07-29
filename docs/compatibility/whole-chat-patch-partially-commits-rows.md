# Whole-chat patches can partially commit external rows

- Status: Confirmed compatibility-path regression
- Severity: High
- Confidence: High

## Difference

main applied /api/patch to a monolithic in-memory chat representation. serve
still accepts payload-bearing whole-chat operations from legacy/external
callers, but externalizes chat bodies before publishing the stub database.
Chat rows are written as independent durable operations.

## Compatibility impact

If the second or later independent chat-row write fails, the route returns 500
while an earlier prefix remains committed. Plugin externalization occurs first
and is internally transactional. The old overwritten chat rows have no
/api/chat-content pre-images, so the durable stub graph can resolve to a mixture
of generations.

There is also an asynchronous case: the route can return 200 after overwriting
rows, then the debounced stub-database transaction can fail later. Old stubs can
then resolve to the newly overwritten rows even though database publication
failed.

The official serve client normally sends stubs plus separate row writes; the
risk is the deliberately retained compatibility request shape.

## Recommendation

Reject payload-bearing whole-chat patch operations in favor of
/api/chat-content, or stage all rows and the stub graph in one synchronous
transaction. Inject failure on the second of two row writes and require neither
to change.
