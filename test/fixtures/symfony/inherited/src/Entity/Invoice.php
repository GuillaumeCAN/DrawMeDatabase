<?php

namespace App\Entity;

use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity]
class Invoice extends BaseRecord
{
    #[ORM\Column(length: 30)]
    private ?string $number = null;
}
