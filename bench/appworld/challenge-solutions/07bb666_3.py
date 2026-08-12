# Hand-written reference solution for challenge task 07bb666_3.
# "Move all products with over 4.3 rating from my amazon cart to wish list."
#
# The challenge split ships no ground-truth solution, so this stands in as the
# Phase-0 positive control: a correct trajectory must grade success=True.
passwords = {entry["account_name"]: entry["password"]
             for entry in apis.supervisor.show_account_passwords()}
profile = apis.supervisor.show_profile()
token = apis.amazon.login(username=profile["email"], password=passwords["amazon"])["access_token"]

cart = apis.amazon.show_cart(access_token=token)
for item in cart["cart_items"]:
    product = apis.amazon.show_product(product_id=item["product_id"])
    # NOTE the boundary: product 1911's true mean rating is 4.2857 (displayed 4.3)
    # and the reference expects it moved for "over 4.3". The generator compares
    # `>=` against the *rounded* rating, so a literal reading of "over" fails this
    # task. Recorded as a REFERENCE-class defect in docs/SCOUT-appworld-challenge.md.
    if product["rating"] >= 4.3:
        apis.amazon.move_product_from_cart_to_wish_list(
            product_id=item["product_id"], access_token=token, quantity=item["quantity"]
        )

apis.supervisor.complete_task(status="success")
