# Hand-written reference solution for challenge task dcb2559_3 (difficulty 2).
# "My spotify premium membership just expired yesterday. Renew it for the same duration."
#
# Phase-0 positive control: the challenge split ships no ground-truth solution,
# so a correct trajectory written by hand must grade success=True.
passwords = {entry["account_name"]: entry["password"]
             for entry in apis.supervisor.show_account_passwords()}
profile = apis.supervisor.show_profile()
token = apis.spotify.login(username=profile["email"], password=passwords["spotify"])["access_token"]

# The most recent subscription is the one that just expired; its span gives the duration.
subscriptions = apis.spotify.show_premium_subscriptions(access_token=token)
latest = max(subscriptions, key=lambda s: s["end_date"])
start, end = latest["start_date"][:10], latest["end_date"][:10]
days = (int(end[:4]) - int(start[:4])) * 365 + (int(end[5:7]) - int(start[5:7])) * 30
duration = "yearly" if days > 60 else "monthly"

# Reuse the card the expired subscription was paid with.
cards = apis.spotify.show_payment_cards(access_token=token)
card = next(c for c in cards if str(c["card_number"]).endswith(latest["payment_card_digits"]))

apis.spotify.subscribe_premium(payment_card_id=card["payment_card_id"], duration=duration,
                               access_token=token)
apis.supervisor.complete_task(status="success")
