import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { MarketplaceQuoteQueryDto } from './dto/marketplace-quote-query.dto';
import { MarketplaceQuotesService } from './marketplace-quotes.service';

@ApiTags('marketplace')
@Controller('marketplace')
export class MarketplaceQuotesController {
  constructor(private readonly quotesService: MarketplaceQuotesService) {}

  /**
   * Quote a strict-receive path payment: the buyer pays `sourceAsset` and the
   * seller receives the listing price in USDC (or the listing currency).
   */
  @Public()
  @Get('quotes')
  @ApiOperation({ summary: 'Get a path-payment quote for a marketplace listing' })
  @ApiResponse({ status: 200, description: 'Best path and unsigned payment XDR' })
  @ApiResponse({ status: 404, description: 'No path exists for this payment' })
  getQuote(@Query() query: MarketplaceQuoteQueryDto) {
    return this.quotesService.getQuote(query);
  }
}
