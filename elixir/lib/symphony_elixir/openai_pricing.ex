defmodule SymphonyElixir.OpenAIPricing do
  @moduledoc """
  Estimates OpenAI token pricing for the observability dashboard.
  """

  @published_rates %{
    "gpt-5" => %{label: "GPT-5", input_per_million_usd: 2.50, output_per_million_usd: 15.00},
    "gpt-5-mini" => %{label: "GPT-5 mini", input_per_million_usd: 0.25, output_per_million_usd: 2.00},
    "gpt-5-nano" => %{label: "GPT-5 nano", input_per_million_usd: 0.05, output_per_million_usd: 0.40},
    "gpt-5-codex" => %{label: "GPT-5-Codex", input_per_million_usd: 2.50, output_per_million_usd: 15.00}
  }

  @model_aliases %{
    "gpt-5.4" => "gpt-5",
    "gpt-5.4-codex" => "gpt-5-codex",
    "gpt-5.3-codex" => "gpt-5-codex"
  }

  @spec estimate(String.t() | nil, map() | nil) :: map()
  def estimate(model, tokens) do
    normalized_model = normalize_model(model)
    pricing_model = Map.get(@model_aliases, normalized_model, normalized_model)

    case Map.get(@published_rates, pricing_model) do
      nil ->
        unavailable(normalized_model)

      rates ->
        input_tokens = token_value(tokens, :input_tokens)
        output_tokens = token_value(tokens, :output_tokens)
        input_cost_usd = usd_for_tokens(input_tokens, rates.input_per_million_usd)
        output_cost_usd = usd_for_tokens(output_tokens, rates.output_per_million_usd)
        total_cost_usd = Float.round(input_cost_usd + output_cost_usd, 6)

        %{
          available: true,
          configured_model: normalized_model,
          pricing_model: pricing_model,
          pricing_label: rates.label,
          input_cost_usd: input_cost_usd,
          output_cost_usd: output_cost_usd,
          total_cost_usd: total_cost_usd,
          cached_input_discount_applied: false
        }
    end
  end

  @spec display_cost(map() | nil) :: String.t()
  def display_cost(%{available: true, total_cost_usd: total_cost_usd}) do
    "$" <> :erlang.float_to_binary(total_cost_usd, decimals: 4)
  end

  def display_cost(_pricing), do: "n/a"

  defp unavailable(configured_model) do
    %{
      available: false,
      configured_model: configured_model,
      pricing_model: nil,
      pricing_label: nil,
      input_cost_usd: nil,
      output_cost_usd: nil,
      total_cost_usd: nil,
      cached_input_discount_applied: false
    }
  end

  defp token_value(tokens, key) when is_map(tokens) do
    value = Map.get(tokens, key) || Map.get(tokens, Atom.to_string(key)) || 0

    if is_integer(value), do: value, else: 0
  end

  defp token_value(_tokens, _key), do: 0

  defp usd_for_tokens(tokens, usd_per_million) do
    Float.round(tokens * usd_per_million / 1_000_000, 6)
  end

  defp normalize_model(model) when is_binary(model) do
    model
    |> String.trim()
    |> String.downcase()
    |> case do
      "" -> nil
      normalized -> normalized
    end
  end

  defp normalize_model(_model), do: nil
end
